/**
 * Task Queue System with Checkpoints
 *
 * Implements resumable tasks following BMAD resilience patterns.
 * Tasks can be paused and resumed from checkpoints on crash recovery.
 *
 * Features:
 * - Task states: PENDING, IN_PROGRESS, COMPLETED, FAILED
 * - Task types: RESEARCH, EVALUATE, MATCH_BET
 * - Checkpoint system for mid-task progress saving
 * - Exponential backoff on failure
 * - Persistent storage to task-queue.json
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Task types supported by the queue
 */
export type TaskType = "RESEARCH" | "EVALUATE" | "MATCH_BET";

/**
 * Task states in the lifecycle
 */
export type TaskState = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

/**
 * Checkpoint names for task progress tracking
 */
export type CheckpointName =
  | "MARKETS_FETCHED"
  | "SEGMENTS_CREATED"
  | "TERMINALS_SPAWNED"
  | "RESEARCH_COMPLETE"
  | "SCORES_AGGREGATED"
  | "BETS_COMPARED"
  | "BET_APPROVED"
  | "TX_SUBMITTED"
  | "TX_CONFIRMED";

/**
 * A checkpoint representing saved progress within a task
 */
export interface Checkpoint {
  /** Name identifying this checkpoint */
  name: CheckpointName;
  /** Unix timestamp when checkpoint was saved */
  timestamp: number;
  /** Arbitrary data saved at this checkpoint */
  data: Record<string, unknown>;
}

/**
 * A task in the queue
 */
export interface Task {
  /** Unique task identifier */
  id: string;
  /** Type of task */
  type: TaskType;
  /** Current state */
  state: TaskState;
  /** Checkpoints saved during execution */
  checkpoints: Checkpoint[];
  /** Number of execution attempts */
  attempts: number;
  /** Maximum allowed attempts before marking FAILED */
  maxAttempts: number;
  /** Timeout in milliseconds */
  timeout: number;
  /** Unix timestamp when task was created */
  createdAt: number;
  /** Unix timestamp when task execution started */
  startedAt?: number;
  /** Unix timestamp when task completed */
  completedAt?: number;
  /** Error message if task failed */
  error?: string;
  /** Task-specific input data */
  input?: Record<string, unknown>;
  /** Task-specific output data */
  output?: Record<string, unknown>;
}

/**
 * Task queue state persisted to file
 */
export interface TaskQueueState {
  tasks: Task[];
  lastUpdated: number;
  version: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Default task timeout in milliseconds (5 minutes) */
export const DEFAULT_TASK_TIMEOUT = 5 * 60 * 1000;

/** Default maximum attempts per task */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Maximum backoff delay in milliseconds (60 seconds) */
export const MAX_BACKOFF_DELAY = 60 * 1000;

/** Base backoff delay in milliseconds (1 second) */
export const BASE_BACKOFF_DELAY = 1000;

// ============================================================================
// Task Queue Class
// ============================================================================

/**
 * Manages a persistent queue of resumable tasks
 */
export class TaskQueue {
  private tasks: Task[] = [];
  private readonly queuePath: string;
  private version = 1;

  /**
   * Create a new task queue
   * @param queuePath Path to persist the queue (defaults to bot/agent/task-queue.json)
   */
  constructor(queuePath: string = "bot/agent/task-queue.json") {
    this.queuePath = queuePath;
    this.load();
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  /**
   * Load queue state from file
   */
  private load(): void {
    if (!existsSync(this.queuePath)) {
      this.tasks = [];
      return;
    }

    try {
      const content = readFileSync(this.queuePath, "utf-8");
      const state = JSON.parse(content) as TaskQueueState;

      this.tasks = state.tasks ?? [];
      this.version = state.version ?? 1;
    } catch {
      // Corrupted file - start fresh
      this.tasks = [];
    }
  }

  /**
   * Save queue state atomically using write-to-temp-then-rename pattern
   */
  private save(): void {
    const dir = dirname(this.queuePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const state: TaskQueueState = {
      tasks: this.tasks,
      lastUpdated: Date.now(),
      version: this.version
    };

    const tempPath = `${this.queuePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(state, null, 2));
    renameSync(tempPath, this.queuePath);
  }

  // --------------------------------------------------------------------------
  // Task Creation
  // --------------------------------------------------------------------------

  /**
   * Generate a unique task ID
   */
  private generateId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Add a new task to the queue
   * @param type Task type
   * @param input Optional input data for the task
   * @param options Optional task configuration
   * @returns The created task
   */
  addTask(
    type: TaskType,
    input?: Record<string, unknown>,
    options?: { timeout?: number; maxAttempts?: number }
  ): Task {
    const task: Task = {
      id: this.generateId(),
      type,
      state: "PENDING",
      checkpoints: [],
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      timeout: options?.timeout ?? DEFAULT_TASK_TIMEOUT,
      createdAt: Date.now(),
      input
    };

    this.tasks.push(task);
    this.save();
    return task;
  }

  // --------------------------------------------------------------------------
  // Task Retrieval
  // --------------------------------------------------------------------------

  /**
   * Get a task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.find(t => t.id === taskId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): Task[] {
    return [...this.tasks];
  }

  /**
   * Get tasks by state
   */
  getTasksByState(state: TaskState): Task[] {
    return this.tasks.filter(t => t.state === state);
  }

  /**
   * Get the next pending task (FIFO order)
   */
  getNextPendingTask(): Task | undefined {
    return this.tasks.find(t => t.state === "PENDING");
  }

  /**
   * Get tasks that were in progress (for recovery)
   */
  getInProgressTasks(): Task[] {
    return this.tasks.filter(t => t.state === "IN_PROGRESS");
  }

  // --------------------------------------------------------------------------
  // Task Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start executing a task
   */
  startTask(taskId: string): Task | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    if (task.state !== "PENDING" && task.state !== "IN_PROGRESS") {
      return task; // Already completed or failed
    }

    task.state = "IN_PROGRESS";
    task.startedAt = Date.now();
    task.attempts++;

    this.save();
    return task;
  }

  /**
   * Mark a task as completed
   */
  completeTask(taskId: string, output?: Record<string, unknown>): Task | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    task.state = "COMPLETED";
    task.completedAt = Date.now();
    if (output) {
      task.output = output;
    }

    this.save();
    return task;
  }

  /**
   * Mark a task as failed
   */
  failTask(taskId: string, error: string): Task | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    // Check if we should retry
    if (task.attempts < task.maxAttempts) {
      task.state = "PENDING"; // Reset to pending for retry
      task.error = error;
    } else {
      task.state = "FAILED";
      task.completedAt = Date.now();
      task.error = error;
    }

    this.save();
    return task;
  }

  // --------------------------------------------------------------------------
  // Checkpoint Management
  // --------------------------------------------------------------------------

  /**
   * Add a checkpoint to a task
   * @param taskId Task ID
   * @param name Checkpoint name
   * @param data Data to save at this checkpoint
   */
  addCheckpoint(
    taskId: string,
    name: CheckpointName,
    data: Record<string, unknown>
  ): Checkpoint | undefined {
    const task = this.getTask(taskId);
    if (!task || task.state !== "IN_PROGRESS") return undefined;

    const checkpoint: Checkpoint = {
      name,
      timestamp: Date.now(),
      data
    };

    task.checkpoints.push(checkpoint);
    this.save();
    return checkpoint;
  }

  /**
   * Get the last checkpoint for a task
   */
  getLastCheckpoint(taskId: string): Checkpoint | undefined {
    const task = this.getTask(taskId);
    if (!task || task.checkpoints.length === 0) return undefined;

    return task.checkpoints[task.checkpoints.length - 1];
  }

  /**
   * Get a specific checkpoint by name
   */
  getCheckpoint(taskId: string, name: CheckpointName): Checkpoint | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    // Return the most recent checkpoint with this name
    for (let i = task.checkpoints.length - 1; i >= 0; i--) {
      if (task.checkpoints[i].name === name) {
        return task.checkpoints[i];
      }
    }
    return undefined;
  }

  // --------------------------------------------------------------------------
  // Task Resume (Crash Recovery)
  // --------------------------------------------------------------------------

  /**
   * Resume a task from its last checkpoint
   * @param taskId Task ID
   * @returns Resume information or undefined if task cannot be resumed
   */
  resumeTask(taskId: string): {
    task: Task;
    lastCheckpoint: Checkpoint | undefined;
    resumeFrom: CheckpointName | "START";
  } | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    // Only resume tasks that were in progress
    if (task.state !== "IN_PROGRESS" && task.state !== "PENDING") {
      return undefined;
    }

    // Mark as in progress if pending
    if (task.state === "PENDING") {
      task.state = "IN_PROGRESS";
      task.startedAt = Date.now();
      task.attempts++;
      this.save();
    }

    const lastCheckpoint = this.getLastCheckpoint(taskId);

    return {
      task,
      lastCheckpoint,
      resumeFrom: lastCheckpoint?.name ?? "START"
    };
  }

  /**
   * Recover all in-progress tasks after a crash
   * @returns List of tasks to resume with their checkpoint info
   */
  recoverTasks(): Array<{
    task: Task;
    lastCheckpoint: Checkpoint | undefined;
    resumeFrom: CheckpointName | "START";
  }> {
    const inProgressTasks = this.getInProgressTasks();
    const recoveryInfo: Array<{
      task: Task;
      lastCheckpoint: Checkpoint | undefined;
      resumeFrom: CheckpointName | "START";
    }> = [];

    for (const task of inProgressTasks) {
      const info = this.resumeTask(task.id);
      if (info) {
        recoveryInfo.push(info);
      }
    }

    return recoveryInfo;
  }

  // --------------------------------------------------------------------------
  // Backoff Calculation
  // --------------------------------------------------------------------------

  /**
   * Calculate exponential backoff delay for a task
   * @param task The task
   * @returns Delay in milliseconds (capped at MAX_BACKOFF_DELAY)
   */
  static calculateBackoff(task: Task): number {
    const delay = BASE_BACKOFF_DELAY * Math.pow(2, task.attempts - 1);
    return Math.min(delay, MAX_BACKOFF_DELAY);
  }

  /**
   * Check if a task has timed out
   */
  static isTaskTimedOut(task: Task): boolean {
    if (!task.startedAt || task.state !== "IN_PROGRESS") return false;
    return Date.now() - task.startedAt > task.timeout;
  }

  // --------------------------------------------------------------------------
  // Queue Management
  // --------------------------------------------------------------------------

  /**
   * Remove completed and failed tasks older than given age
   * @param maxAgeMs Maximum age in milliseconds (default: 24 hours)
   */
  pruneOldTasks(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const initialCount = this.tasks.length;

    this.tasks = this.tasks.filter(t => {
      // Keep all pending and in-progress tasks
      if (t.state === "PENDING" || t.state === "IN_PROGRESS") return true;

      // Keep completed/failed tasks newer than cutoff
      const completionTime = t.completedAt ?? t.createdAt;
      return completionTime > cutoff;
    });

    const prunedCount = initialCount - this.tasks.length;
    if (prunedCount > 0) {
      this.save();
    }

    return prunedCount;
  }

  /**
   * Clear all tasks (for testing or manual reset)
   */
  clear(): void {
    this.tasks = [];
    this.save();
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
  } {
    return {
      total: this.tasks.length,
      pending: this.tasks.filter(t => t.state === "PENDING").length,
      inProgress: this.tasks.filter(t => t.state === "IN_PROGRESS").length,
      completed: this.tasks.filter(t => t.state === "COMPLETED").length,
      failed: this.tasks.filter(t => t.state === "FAILED").length
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let taskQueueInstance: TaskQueue | null = null;

/**
 * Get or create the global task queue instance
 */
export function getTaskQueue(queuePath?: string): TaskQueue {
  if (!taskQueueInstance) {
    taskQueueInstance = new TaskQueue(queuePath);
  }
  return taskQueueInstance;
}

/**
 * Initialize the task queue with a specific path
 */
export function initTaskQueue(queuePath: string): TaskQueue {
  taskQueueInstance = new TaskQueue(queuePath);
  return taskQueueInstance;
}
