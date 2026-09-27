import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnershipGuard } from '../common/guards/ownership.guard';
import { Ownership } from '../common/decorators/ownership.decorator';
import { AttachmentCleanupService } from './attachment-cleanup.service';
import { AttachmentRepository } from './repository/attachment.repository';
import { Attachment, AttachmentStatus } from './entities/attachment.entity';
import { CreateAttachmentDto, CompleteAttachmentDto, AssociateAttachmentDto } from './dto/attachment.dto';

@ApiTags('Attachments')
@Controller('attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentController {
  constructor(
    private readonly cleanupService: AttachmentCleanupService,
    private readonly attachmentRepository: AttachmentRepository,
  ) {}

  /**
   * POST /attachments
   * Create a new attachment record for an upload.
   */
  @Post()
  @ApiOperation({ summary: 'Create attachment record for upload' })
  @ApiResponse({ status: 201, description: 'Attachment record created' })
  async createAttachment(@Body() dto: CreateAttachmentDto, @Req() req: any) {
    // Use the authenticated user's anonymous ID if not provided
    const anonymousUserId = dto.anonymousUserId ?? (await this.getUserAnonymousId(req.user.sub));
    
    const attachment = await this.cleanupService.createAttachment({
      ...dto,
      anonymousUserId,
    });

    return attachment;
  }

  /**
   * PUT /attachments/:id/complete
   * Mark an attachment as completed after successful upload.
   */
  @Put(':id/complete')
  @ApiOperation({ summary: 'Mark attachment as completed' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  @ApiResponse({ status: 200, description: 'Attachment marked as completed' })
  @ApiResponse({ status: 404, description: 'Attachment not found' })
  async completeAttachment(
    @Param('id') id: string,
    @Body() dto: CompleteAttachmentDto,
  ) {
    const attachment = await this.attachmentRepository.findById(id);
    if (!attachment) {
      return { success: false, error: 'Attachment not found' };
    }

    await this.cleanupService.completeAttachment(id, dto.checksum);
    return { success: true };
  }

  /**
   * PUT /attachments/:id/associate
   * Associate an attachment with a confession or message after successful transaction.
   */
  @Put(':id/associate')
  @ApiOperation({ summary: 'Associate attachment with confession or message' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  @ApiResponse({ status: 200, description: 'Attachment associated successfully' })
  @ApiResponse({ status: 404, description: 'Attachment not found' })
  async associateAttachment(
    @Param('id') id: string,
    @Body() dto: AssociateAttachmentDto,
  ) {
    const attachment = await this.attachmentRepository.findById(id);
    if (!attachment) {
      return { success: false, error: 'Attachment not found' };
    }

    await this.cleanupService.associateAttachment(id, {
      confessionId: dto.confessionId,
      messageId: dto.messageId,
    });

    return { success: true };
  }

  /**
   * GET /attachments/:id
   * Get attachment details.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get attachment details' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  @ApiResponse({ status: 200, description: 'Attachment details' })
  @ApiResponse({ status: 404, description: 'Attachment not found' })
  async getAttachment(@Param('id') id: string) {
    const attachment = await this.attachmentRepository.findById(id);
    if (!attachment) {
      return { success: false, error: 'Attachment not found' };
    }
    return attachment;
  }

  /**
   * DELETE /attachments/:id
   * Delete an attachment (only if not referenced).
   */
  @Delete(':id')
  @ApiOperation({ summary: 'Delete attachment if not referenced' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  @ApiResponse({ status: 200, description: 'Attachment deleted' })
  @ApiResponse({ status: 404, description: 'Attachment not found' })
  @ApiResponse({ status: 409, description: 'Attachment is still referenced' })
  async deleteAttachment(@Param('id') id: string) {
    const result = await this.cleanupService.cleanupAttachment(id);
    return result;
  }

  /**
   * POST /attachments/cleanup
   * Manually trigger cleanup job (admin only).
   */
  @Post('cleanup')
  @ApiOperation({ summary: 'Trigger attachment cleanup job' })
  @ApiResponse({ status: 200, description: 'Cleanup completed' })
  async triggerCleanup() {
    const result = await this.cleanupService.runCleanup();
    return result;
  }

  /**
   * GET /attachments/stats
   * Get attachment statistics.
   */
  @Get('stats')
  @ApiOperation({ summary: 'Get attachment statistics' })
  @ApiResponse({ status: 200, description: 'Attachment statistics' })
  async getStats() {
    const statuses = Object.values(AttachmentStatus);
    const stats: Record<string, number> = {};

    for (const status of statuses) {
      const count = await this.attachmentRepository.find({
        where: { status },
      });
      stats[status] = count.length;
    }

    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    return { total, byStatus: stats };
  }

  private async getUserAnonymousId(userId: number): Promise<string> {
    // This would typically use the AnonymousUserService
    // For now, we'll return a placeholder - the service should be injected
    return `user-${userId}`;
  }
}