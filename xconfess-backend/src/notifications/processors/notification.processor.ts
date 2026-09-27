import { Processor, OnWorkerEvent, InjectQueue, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { EmailNotificationService } from '../services/email-notification.service';
import { NotificationType } from '../entities/notification.entity';
import { AppLogger } from '../../logger/logger.service';

export const NOTIFICATION_QUEUE = 'notifications';
export const NOTIFICATION_DLQ = 'notifications-dlq';

export interface NotificationJobData {
  userId: string;
  type: string; // Unified with NotificationType or string
  title: string;
  message: string;
  /** Stable idempotency key — prevents duplicate delivery across retries (#1980). */
  idempotencyKey?: string;
  /** Correlation ID from originating request — links background jobs to initiating operation. */
  requestId?: string;
  metadata?: any;
  _meta?: {
    originalJobId: string | undefined;
    failedAt: string;
    attemptsMade: number;
    lastError: string;
    replayJobId?: string;
    replayedAt?: string;
    replayOutcome?: 'replayed' | 'deduplicated';
    /** Number of times this job has been replayed from the DLQ (#1981). */
    replayCount?: number;
  };
}

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly emailNotificationService: EmailNotificationService,
    @InjectQueue(NOTIFICATION_DLQ)
    private readonly dlq: Queue<NotificationJobData>,
    private readonly appLogger: AppLogger,
  ) {
    super();
  }

  // ------------------------------------------------------------------ process
  async process(job: Job<NotificationJobData>): Promise<void> {
    if (job.name === 'send-notification') {
      // Idempotency guard (#1980): skip if this job was already delivered.
      const idempotencyKey = job.data.idempotencyKey;
      if (idempotencyKey) {
        const lockKey = `notif_delivered:${idempotencyKey}`;
        const alreadyDelivered = await this.checkIdempotency(lockKey);
        if (alreadyDelivered) {
          this.logger.log(
            `Skipping duplicate notification job ${job.id} (idempotencyKey: ${idempotencyKey})`,
          );
          return;
        }
        await this.markDelivered(lockKey);
      }

      this.logger.log(
        `Processing notification job ${job.id} (attempt ${job.attemptsMade + 1})` +
          ` → userId: ${job.data.userId}` +
          `${job.data.requestId ? ` requestId: ${job.data.requestId}` : ''}`,
      );

      this.appLogger.incrementCounter('notification_queue_processing_total', 1, {
        queue: NOTIFICATION_QUEUE,
        jobName: job.name,
      });

      const startedAt = Date.now();
      await this.emailNotificationService.sendEmail(job.data);
      this.appLogger.observeTimer(
        'notification_queue_processing_duration_ms',
        Date.now() - startedAt,
        {
          queue: NOTIFICATION_QUEUE,
          jobName: job.name,
        },
      );
    }
  }

  // --------------------------------------------------------------- on:failed
  /**
   * Called after every failed attempt.
   * When all attempts are exhausted BullMQ marks the job "failed" — we then
   * copy the full payload + error context into the dead-letter queue.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<NotificationJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = (job.opts as any)?.attempts ?? 1;

    this.logger.warn(
      `Job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
    );

    const isExhausted = job.attemptsMade >= maxAttempts;

    if (!isExhausted) {
      this.appLogger.incrementCounter('notification_queue_retry_total', 1, {
        queue: NOTIFICATION_QUEUE,
        jobName: job.name,
        attempt: job.attemptsMade,
      });
    } else {
      this.appLogger.incrementCounter('notification_queue_failure_total', 1, {
        queue: NOTIFICATION_QUEUE,
        jobName: job.name,
      });
      this.appLogger.incrementCounter('notification_queue_dlq_total', 1, {
        queue: NOTIFICATION_QUEUE,
        jobName: job.name,
      });

      this.logger.error(
        `Job ${job.id} exhausted all retries — moving to DLQ`,
        error.stack,
      );

      await this.dlq.add(
        'dead-letter',
        {
          ...job.data,
          _meta: {
            originalJobId: String(job.id),
            failedAt: new Date().toISOString(),
            attemptsMade: job.attemptsMade,
            lastError: error.message,
          },
        },
        {
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    }
  }

  // -------------------------------------------------------------- on:completed
  @OnWorkerEvent('completed')
  onCompleted(job: Job<NotificationJobData> | undefined): void {
    if (job) {
      this.logger.log(`Job ${job.id} completed successfully`);
    }
  }

  // --------------------------------------------------------- idempotency (#1980)
  /**
   * Check whether a notification with the given idempotency key has already
   * been delivered. Uses an in-memory Set — swap for Redis/DB in production
   * if the worker scales horizontally.
   */
  private deliveredKeys = new Set<string>();

  private async checkIdempotency(key: string): Promise<boolean> {
    return this.deliveredKeys.has(key);
  }

  private async markDelivered(key: string): Promise<void> {
    this.deliveredKeys.add(key);
    // Evict after 24 hours to prevent unbounded memory growth.
    setTimeout(() => this.deliveredKeys.delete(key), 24 * 60 * 60 * 1000);
  }
}
