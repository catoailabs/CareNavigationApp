import fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Page } from 'playwright';
import { BrowserToolBase } from './base.js';
import { ToolContext, ToolResponse, createSuccessResponse } from '../common/types.js';

const defaultDownloadsPath = path.join(os.homedir(), 'Downloads');
const defaultCacheMaxBytes = 450000;
const defaultCacheMaxItems = 50;
const defaultCacheTtlSeconds = 1800;

type ScreenshotCacheEntry = {
  base64?: string;
  filePath: string;
  mimeType: string;
  createdAt: number;
  sizeBytes: number;
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

/**
 * Tool for taking screenshots of pages or elements
 */
export class ScreenshotTool extends BrowserToolBase {
  private screenshots = new Map<string, ScreenshotCacheEntry>();

  private getCacheConfig() {
    return {
      maxBytes: clampInt(process.env.STRANDS_SCREENSHOT_MAX_BYTES, 50000, 5000000, defaultCacheMaxBytes),
      maxItems: clampInt(process.env.STRANDS_SCREENSHOT_CACHE_MAX_ITEMS, 1, 500, defaultCacheMaxItems),
      ttlSeconds: clampInt(process.env.STRANDS_SCREENSHOT_CACHE_TTL_SECONDS, 60, 86400, defaultCacheTtlSeconds),
    };
  }

  private cleanupScreenshots() {
    const { maxItems, ttlSeconds } = this.getCacheConfig();
    const now = Date.now();
    const cacheRoot = process.env.STRANDS_SCREENSHOT_CACHE_DIR;
    const cacheRootResolved = cacheRoot ? path.resolve(cacheRoot) : null;

    if (ttlSeconds > 0) {
      const cutoff = now - ttlSeconds * 1000;
      for (const [name, entry] of this.screenshots.entries()) {
        if (entry.createdAt < cutoff) {
          if (cacheRootResolved && entry.filePath) {
            try {
              const resolved = path.resolve(entry.filePath);
              if (resolved.startsWith(cacheRootResolved) && fs.existsSync(resolved)) {
                fs.unlinkSync(resolved);
              }
            } catch {
              // ignore cleanup errors
            }
          }
          this.screenshots.delete(name);
        }
      }
    }

    if (maxItems > 0 && this.screenshots.size > maxItems) {
      const ordered = Array.from(this.screenshots.entries()).sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      );
      const overflow = ordered.slice(0, this.screenshots.size - maxItems);
      for (const [name] of overflow) {
        const entry = this.screenshots.get(name);
        if (entry && cacheRootResolved && entry.filePath) {
          try {
            const resolved = path.resolve(entry.filePath);
            if (resolved.startsWith(cacheRootResolved) && fs.existsSync(resolved)) {
              fs.unlinkSync(resolved);
            }
          } catch {
            // ignore cleanup errors
          }
        }
        this.screenshots.delete(name);
      }
    }
  }

  /**
   * Execute the screenshot tool
   */
  async execute(args: any, context: ToolContext): Promise<ToolResponse> {
    return this.safeExecute(context, async (page) => {
      const format = String(args.type || process.env.STRANDS_SCREENSHOT_FORMAT || "jpeg").toLowerCase();
      const normalizedFormat = format === "jpg" ? "jpeg" : format;
      const isJpeg = normalizedFormat === "jpeg";
      const quality = clampInt(
        args.quality ?? process.env.STRANDS_SCREENSHOT_JPEG_QUALITY,
        20,
        95,
        45
      );
      const screenshotOptions: any = {
        type: isJpeg ? "jpeg" : "png",
        fullPage: !!args.fullPage,
      };
      if (isJpeg) {
        screenshotOptions.quality = quality;
      }

      if (args.selector) {
        const element = await page.$(args.selector);
        if (!element) {
          return {
            content: [{
              type: "text",
              text: `Element not found: ${args.selector}`,
            }],
            isError: true
          };
        }
        screenshotOptions.element = element;
      }

      // Generate output path
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const extension = isJpeg ? "jpg" : "png";
      const filename = `${args.name || 'screenshot'}-${timestamp}.${extension}`;
      const downloadsDir =
        args.downloadsDir || process.env.STRANDS_SCREENSHOT_CACHE_DIR || defaultDownloadsPath;

      if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
      }

      const outputPath = path.join(downloadsDir, filename);
      screenshotOptions.path = outputPath;

      const screenshot = await page.screenshot(screenshotOptions);

      const messages = [`Screenshot saved to: ${path.relative(process.cwd(), outputPath)}`];

      // Handle base64 storage
      if (args.storeBase64 !== false) {
        const cacheConfig = this.getCacheConfig();
        const entry: ScreenshotCacheEntry = {
          filePath: outputPath,
          mimeType: isJpeg ? "image/jpeg" : "image/png",
          createdAt: Date.now(),
          sizeBytes: screenshot.length,
        };

        if (screenshot.length <= cacheConfig.maxBytes) {
          entry.base64 = screenshot.toString("base64");
          messages.push(`Screenshot cached in memory (${Math.round(screenshot.length / 1024)} KB).`);
        } else {
          messages.push(
            `Screenshot cached on disk (${Math.round(screenshot.length / 1024)} KB). Base64 omitted due to size limit.`
          );
        }

        this.screenshots.set(args.name || 'screenshot', entry);
        this.cleanupScreenshots();
        this.server.notification({
          method: "notifications/resources/list_changed",
        });
        messages.push(`Screenshot registered as resource: '${args.name || 'screenshot'}'`);
      }

      return createSuccessResponse(messages);
    });
  }

  /**
   * Get all stored screenshots
   */
  getScreenshots(): Map<string, ScreenshotCacheEntry> {
    return this.screenshots;
  }
} 