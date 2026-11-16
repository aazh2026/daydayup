/**
 * 定时任务调度器。
 *
 * 用 node:timers 实现（保持零第三方依赖）。
 *
 * 任务：
 * - 每日自动备份
 * - 每日自动清理过期数据
 * - 每日配额重置检查（配额本身按日期自动滚动，无需额外处理）
 *
 * 设计要点：
 * - 服务重启后立即检查「今天是否已执行过」，避免重复执行
 * - 执行失败只记录日志，不影响服务
 * - 与 Job Engine 相互独立，避免相互阻塞
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logging/logger.ts';

export interface ScheduledTask {
  name: string;
  /** 执行间隔（毫秒） */
  intervalMs: number;
  /** 执行函数 */
  run: () => Promise<void>;
  /** 是否为每日任务（按日期去重） */
  daily?: boolean;
}

export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  /** 每日任务的执行标记：{ taskName: dateKey } */
  private dailyMarkers = new Map<string, string>();

  private readonly tasks: ScheduledTask[];
  private readonly markerDir: string;

  constructor(tasks: ScheduledTask[], markerDir: string) {
    this.tasks = tasks;
    this.markerDir = markerDir;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.loadMarkers();

    for (const task of this.tasks) {
      if (task.daily) {
        await this.runDailyIfNeeded(task);
      }

      const timer = setInterval(() => {
        // 每日任务必须走 runDailyIfNeeded，否则会在每个周期重复执行
        if (task.daily) {
          void this.runDailyIfNeeded(task);
        } else {
          void this.runTask(task);
        }
      }, task.intervalMs);
      timer.unref?.();
      this.timers.push(timer);
    }

    logger.info('scheduler.started', {
      tasks: this.tasks.map((t) => t.name),
    });
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    logger.info('scheduler.stopped');
  }

  /** 立即执行全部任务（用于测试与手动触发） */
  async runAll(): Promise<void> {
    for (const task of this.tasks) {
      await this.runTask(task);
    }
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    if (!this.running) return;
    try {
      await task.run();
      if (task.daily) await this.markDaily(task.name);
    } catch (err) {
      logger.error('scheduler.task_failed', {
        task: task.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 每日任务：若今天尚未执行则执行 */
  private async runDailyIfNeeded(task: ScheduledTask): Promise<void> {
    const today = this.today();
    if (this.dailyMarkers.get(task.name) === today) return;
    await this.runTask(task);
  }

  private async markDaily(taskName: string): Promise<void> {
    const today = this.today();
    this.dailyMarkers.set(taskName, today);
    try {
      await fs.mkdir(this.markerDir, { recursive: true });
      await fs.writeFile(
        path.join(this.markerDir, `${taskName}.marker`),
        today,
        'utf8'
      );
    } catch {
      // 标记失败不影响任务本身
    }
  }

  private async loadMarkers(): Promise<void> {
    try {
      const files = await fs.readdir(this.markerDir);
      for (const file of files) {
        if (!file.endsWith('.marker')) continue;
        const name = file.replace(/\.marker$/, '');
        const date = await fs
          .readFile(path.join(this.markerDir, file), 'utf8')
          .catch(() => '');
        if (date) this.dailyMarkers.set(name, date.trim());
      }
    } catch {
      // 目录不存在是正常情况
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
