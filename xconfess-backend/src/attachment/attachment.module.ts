import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Attachment } from './entities/attachment.entity';
import { AttachmentRepository } from './repository/attachment.repository';
import { AttachmentCleanupService } from './attachment-cleanup.service';

@Module({
  imports: [TypeOrmModule.forFeature([Attachment])],
  providers: [AttachmentRepository, AttachmentCleanupService],
  exports: [AttachmentRepository, AttachmentCleanupService],
})
export class AttachmentModule {}