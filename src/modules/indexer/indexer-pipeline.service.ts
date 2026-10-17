import { createHash } from 'crypto';
import { prisma } from '../../utils/prisma.utils';
import { updateOwnership } from '../ownership/ownership.service';
import { upsertPriceSnapshot } from './price-snapshot.service';
import { updateIndexedLedger } from './ledger-gap-detection.service';
import { logger } from '../../utils/logger.utils';
import { processIndexerChainEvents, IndexerChainEvent } from '../../utils/indexer-event-processor.utils';
import { dedupeChainEvents } from '../../utils/indexer-dedupe.utils';
import { logSellTransactionConfirmed } from '../../utils/sell-transaction-logger.utils';
import {
   processSocialMetadataEvents,
   SOCIAL_METADATA_UPDATED_EVENT_TYPE,
} from './social-metadata-indexer.service';

function isTradeEvent(event: IndexerChainEvent): boolean {
   return (
      event.eventType === 'KEY_BOUGHT' || event.eventType === 'KEY_SOLD'
   );
}

export interface TradeEventProcessingOptions {
   /**
    * Advance the shared ledger cursor after processing the batch.
    * Defaults to true so direct callers keep the original behavior; the
    * pipeline dispatcher (`processIndexerEvents`) sets it to false and
    * advances the cursor once over the whole mixed batch instead.
    */
   advanceCursor?: boolean;
}

/**
 * Processes a batch of on-chain trade events (KEY_BOUGHT or KEY_SOLD).
 *
 * - Deduplicates the events based on txHash and eventIndex.
 * - Parses and validates each event.
 * - Creates an Activity record (representing the trade).
 * - Updates the KeyOwnership read model.
 * - Upserts the CreatorPriceSnapshot read model.
 * - Writes a checkpoint record of the highest ledger processed.
 */
export async function processTradeEvents(
   events: IndexerChainEvent[],
   options: TradeEventProcessingOptions = {}
): Promise<void> {
   const { advanceCursor = true } = options;

   await processIndexerChainEvents(events, async (event) => {
      // Validate event type
      if (event.eventType !== 'KEY_BOUGHT' && event.eventType !== 'KEY_SOLD') {
         return;
      }

      // Check required fields. Skip with a warn-level log if any is missing.
      const requiredFields = ['creatorId', 'actor', 'amount', 'price', 'feePaid', 'tradeAt', 'ledger'];
      for (const field of requiredFields) {
         if (event[field] === undefined || event[field] === null || event[field] === '') {
            logger.warn(
               { eventId: `${event.txHash}:${event.eventIndex}`, missingField: field },
               'Skipping trade event due to missing required field'
            );
            return;
         }
      }

      const { creatorId, actor, amount, price, feePaid, tradeAt, ledger } = event;

      // 1. Create corresponding Activity record
      await prisma.activity.create({
         data: {
            type: event.eventType as any,
            actor,
            creatorId,
            payload: {
               amount: Number(amount),
               price_at_trade: price.toString(),
               fee_paid: feePaid.toString(),
               ledger_sequence: Number(ledger),
            },
            createdAt: new Date(tradeAt),
         },
      });

      // 2. updateOwnership (balance delta: positive for buy, negative for sell)
      const balanceChange = event.eventType === 'KEY_BOUGHT' ? Number(amount) : -Number(amount);
      await updateOwnership(actor, creatorId, balanceChange, {
         event_type: event.eventType === 'KEY_BOUGHT' ? 'buy' : 'sell',
         ledger_sequence: Number(ledger),
      });

      // 3. upsertPriceSnapshot
      await upsertPriceSnapshot({
         creatorId,
         price: BigInt(price),
         tradeAt: new Date(tradeAt),
         ledger: Number(ledger),
      });

      // 4. Emit a structured log for confirmed sells, mirroring buy-side logging.
      if (event.eventType === 'KEY_SOLD') {
         const [creatorProfile, supplyAggregate] = await Promise.all([
            prisma.creatorProfile.findUnique({
               where: { id: creatorId },
               select: { user: { select: { stellarWallet: { select: { address: true } } } } },
            }),
            prisma.keyOwnership.aggregate({
               where: { creatorId },
               _sum: { balance: true },
            }),
         ]);

         logSellTransactionConfirmed({
            sellerWallet: actor,
            creatorWallet: creatorProfile?.user?.stellarWallet?.address ?? '',
            keyAmount: Number(amount),
            xlmReceivedStroops: BigInt(price),
            newSupply: Number(supplyAggregate._sum.balance ?? 0),
            txHash: event.txHash,
            confirmedAt: new Date(tradeAt),
         });
      }
   });

   if (!advanceCursor) {
      return;
   }

   await advanceIndexerCursorForBatch(events);
}

/**
 * Advances the shared ledger cursor to the highest ledger in the batch.
 *
 * The cursor is a single global checkpoint (`IndexedLedger`, id=1) that the
 * worker uses to resume polling, so it must only move forward over events
 * that have already been fully processed.
 */
export async function advanceIndexerCursorForBatch(
   events: IndexerChainEvent[]
): Promise<void> {
   const uniqueEvents = dedupeChainEvents(events);

   const processedLedgers = uniqueEvents
      .map(e => e.ledger)
      .filter((l): l is number => typeof l === 'number');

   if (processedLedgers.length > 0) {
      const maxLedger = Math.max(...processedLedgers);
      const batchHash = computeBatchHash(uniqueEvents);
      const cursor = `${maxLedger}-000`;
      await updateIndexedLedger(maxLedger, cursor, batchHash);
   }
}

/**
 * Processes a mixed batch of indexer events (trades + social metadata).
 *
 * Routes each event type to its handler and advances the ledger cursor
 * exactly once, over the full batch, so batches containing only social
 * metadata events still make cursor progress.
 */
export async function processIndexerEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   const tradeEvents = events.filter(isTradeEvent);
   const socialEvents = events.filter(
      event => event.eventType === SOCIAL_METADATA_UPDATED_EVENT_TYPE
   );

   if (socialEvents.length > 0) {
      await processSocialMetadataEvents(socialEvents);
   }

   if (tradeEvents.length > 0) {
      await processTradeEvents(tradeEvents, { advanceCursor: false });
   }

   await advanceIndexerCursorForBatch(events);
}

function computeBatchHash(events: Array<{ txHash: string; eventIndex: number }>): string {
   const identifiers = events
      .map(e => `${e.txHash}:${e.eventIndex}`)
      .sort()
      .join('|');
   return createHash('sha256').update(identifiers, 'utf8').digest('hex').slice(0, 16);
}
