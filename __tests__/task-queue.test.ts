/**
 * Tests for Task Queue System with Checkpoints
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmdirSync } from "fs";
import { join, dirname } from "path";
import {
  TaskQueue,
  DEFAULT_TASK_TIMEOUT,
  DEFAULT_MAX_ATTEMPTS,
  MAX_BACKOFF_DELAY,
  BASE_BACKOFF_DELAY,
  type Task,
  type TaskType,
  type CheckpointName
} from "../src/task-queue";

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_QUEUE_PATH = "/tmp/test-task-queue.json";

function cleanupTestFile(): void {
  if (existsSync(TEST_QUEUE_PATH)) {
    unlinkSync(TEST_QUEUE_PATH);
  }
  const tmpPath = `${TEST_QUEUE_PATH}.tmp`;
  if (existsSync(tmpPath)) {
    unlinkSync(tmpPath);
  }
}

// ============================================================================
// TaskQueue Tests
// ============================================================================

describe("TaskQueue", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    cleanupTestFile();
    queue = new TaskQueue(TEST_QUEUE_PATH);
  });

  afterEach(() => {
    cleanupTestFile();
  });

  describe("Constructor and Persistence", () => {
    test("creates empty queue when file does not exist", () => {
      const stats = queue.getStats();
      expect(stats.total).toBe(0);
    });

    test("loads existing queue from file", () => {
      // Add some tasks
      queue.addTask("RESEARCH");
      queue.addTask("EVALUATE");

      // Create new queue instance pointing to same file
      const queue2 = new TaskQueue(TEST_QUEUE_PATH);
      const stats = queue2.getStats();

      expect(stats.total).toBe(2);
    });

    test("handles corrupted file gracefully", () => {
      const { writeFileSync } = require("fs");
      writeFileSync(TEST_QUEUE_PATH, "not valid json");

      const queue2 = new TaskQueue(TEST_QUEUE_PATH);
      const stats = queue2.getStats();

      expect(stats.total).toBe(0);
    });
  });

  describe("addTask", () => {
    test("adds task with default configuration", () => {
      const task = queue.addTask("RESEARCH");

      expect(task.id).toMatch(/^task_\d+_\w+$/);
      expect(task.type).toBe("RESEARCH");
      expect(task.state).toBe("PENDING");
      expect(task.attempts).toBe(0);
      expect(task.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
      expect(task.timeout).toBe(DEFAULT_TASK_TIMEOUT);
      expect(task.checkpoints).toEqual([]);
      expect(task.createdAt).toBeGreaterThan(0);
    });

    test("accepts input data", () => {
      const task = queue.addTask("MATCH_BET", { betId: "bet123", amount: "1000" });

      expect(task.input).toEqual({ betId: "bet123", amount: "1000" });
    });

    test("accepts custom timeout and maxAttempts", () => {
      const task = queue.addTask("EVALUATE", undefined, {
        timeout: 10000,
        maxAttempts: 5
      });

      expect(task.timeout).toBe(10000);
      expect(task.maxAttempts).toBe(5);
    });

    test("persists task to file", () => {
      queue.addTask("RESEARCH");

      const queue2 = new TaskQueue(TEST_QUEUE_PATH);
      expect(queue2.getStats().total).toBe(1);
    });
  });

  describe("getTask", () => {
    test("returns task by ID", () => {
      const created = queue.addTask("RESEARCH");
      const retrieved = queue.getTask(created.id);

      expect(retrieved).toEqual(created);
    });

    test("returns undefined for non-existent ID", () => {
      const task = queue.getTask("non-existent");
      expect(task).toBeUndefined();
    });
  });

  describe("getTasksByState", () => {
    test("returns tasks filtered by state", () => {
      const task1 = queue.addTask("RESEARCH");
      const task2 = queue.addTask("EVALUATE");
      queue.startTask(task1.id);

      const pending = queue.getTasksByState("PENDING");
      const inProgress = queue.getTasksByState("IN_PROGRESS");

      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(task2.id);
      expect(inProgress.length).toBe(1);
      expect(inProgress[0].id).toBe(task1.id);
    });
  });

  describe("getNextPendingTask", () => {
    test("returns first pending task (FIFO)", () => {
      const task1 = queue.addTask("RESEARCH");
      queue.addTask("EVALUATE");

      const next = queue.getNextPendingTask();

      expect(next?.id).toBe(task1.id);
    });

    test("returns undefined when no pending tasks", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);
      queue.completeTask(task.id);

      const next = queue.getNextPendingTask();

      expect(next).toBeUndefined();
    });
  });

  describe("Task Lifecycle", () => {
    test("startTask transitions PENDING to IN_PROGRESS", () => {
      const task = queue.addTask("RESEARCH");

      const started = queue.startTask(task.id);

      expect(started?.state).toBe("IN_PROGRESS");
      expect(started?.startedAt).toBeGreaterThan(0);
      expect(started?.attempts).toBe(1);
    });

    test("startTask increments attempts each time", () => {
      const task = queue.addTask("RESEARCH");

      queue.startTask(task.id);
      queue.failTask(task.id, "error"); // Back to PENDING
      queue.startTask(task.id);

      const retrieved = queue.getTask(task.id);
      expect(retrieved?.attempts).toBe(2);
    });

    test("completeTask transitions to COMPLETED", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);

      const completed = queue.completeTask(task.id, { result: "success" });

      expect(completed?.state).toBe("COMPLETED");
      expect(completed?.completedAt).toBeGreaterThan(0);
      expect(completed?.output).toEqual({ result: "success" });
    });

    test("failTask transitions back to PENDING if attempts remain", () => {
      const task = queue.addTask("RESEARCH", undefined, { maxAttempts: 3 });
      queue.startTask(task.id);

      const failed = queue.failTask(task.id, "temporary error");

      expect(failed?.state).toBe("PENDING");
      expect(failed?.error).toBe("temporary error");
    });

    test("failTask transitions to FAILED after max attempts", () => {
      const task = queue.addTask("RESEARCH", undefined, { maxAttempts: 2 });

      // Attempt 1
      queue.startTask(task.id);
      queue.failTask(task.id, "error 1");

      // Attempt 2
      queue.startTask(task.id);
      const failed = queue.failTask(task.id, "error 2");

      expect(failed?.state).toBe("FAILED");
      expect(failed?.completedAt).toBeGreaterThan(0);
      expect(failed?.error).toBe("error 2");
    });
  });

  describe("Checkpoint Management", () => {
    test("addCheckpoint saves checkpoint to task", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);

      const checkpoint = queue.addCheckpoint(task.id, "MARKETS_FETCHED", {
        markets: ["market1", "market2"]
      });

      expect(checkpoint?.name).toBe("MARKETS_FETCHED");
      expect(checkpoint?.timestamp).toBeGreaterThan(0);
      expect(checkpoint?.data).toEqual({ markets: ["market1", "market2"] });
    });

    test("addCheckpoint returns undefined for non-existent task", () => {
      const checkpoint = queue.addCheckpoint("non-existent", "MARKETS_FETCHED", {});
      expect(checkpoint).toBeUndefined();
    });

    test("addCheckpoint returns undefined if task not IN_PROGRESS", () => {
      const task = queue.addTask("RESEARCH");
      // Task is still PENDING

      const checkpoint = queue.addCheckpoint(task.id, "MARKETS_FETCHED", {});

      expect(checkpoint).toBeUndefined();
    });

    test("getLastCheckpoint returns most recent checkpoint", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);

      queue.addCheckpoint(task.id, "MARKETS_FETCHED", { step: 1 });
      queue.addCheckpoint(task.id, "SEGMENTS_CREATED", { step: 2 });
      queue.addCheckpoint(task.id, "TERMINALS_SPAWNED", { step: 3 });

      const last = queue.getLastCheckpoint(task.id);

      expect(last?.name).toBe("TERMINALS_SPAWNED");
      expect(last?.data).toEqual({ step: 3 });
    });

    test("getCheckpoint returns specific checkpoint by name", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);

      queue.addCheckpoint(task.id, "MARKETS_FETCHED", { markets: 5 });
      queue.addCheckpoint(task.id, "SEGMENTS_CREATED", { segments: 3 });

      const checkpoint = queue.getCheckpoint(task.id, "MARKETS_FETCHED");

      expect(checkpoint?.name).toBe("MARKETS_FETCHED");
      expect(checkpoint?.data).toEqual({ markets: 5 });
    });

    test("getCheckpoint returns most recent if multiple with same name", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);

      queue.addCheckpoint(task.id, "MARKETS_FETCHED", { count: 1 });
      queue.addCheckpoint(task.id, "MARKETS_FETCHED", { count: 2 });

      const checkpoint = queue.getCheckpoint(task.id, "MARKETS_FETCHED");

      expect(checkpoint?.data).toEqual({ count: 2 });
    });

    test("checkpoints persist to file", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);
      queue.addCheckpoint(task.id, "MARKETS_FETCHED", { data: "test" });

      const queue2 = new TaskQueue(TEST_QUEUE_PATH);
      const checkpoint = queue2.getLastCheckpoint(task.id);

      expect(checkpoint?.name).toBe("MARKETS_FETCHED");
    });
  });

  describe("Task Resume (Crash Recovery)", () => {
    test("resumeTask returns task and checkpoint info", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);
      queue.addCheckpoint(task.id, "MARKETS_FETCHED", { markets: 10 });
      queue.addCheckpoint(task.id, "SEGMENTS_CREATED", { segments: 3 });

      // Simulate crash by creating new queue instance
      const queue2 = new TaskQueue(TEST_QUEUE_PATH);
      const resumeInfo = queue2.resumeTask(task.id);

      expect(resumeInfo).toBeDefined();
      expect(resumeInfo?.task.id).toBe(task.id);
      expect(resumeInfo?.lastCheckpoint?.name).toBe("SEGMENTS_CREATED");
      expect(resumeInfo?.resumeFrom).toBe("SEGMENTS_CREATED");
    });

    test("resumeTask returns START when no checkpoints", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);

      const resumeInfo = queue.resumeTask(task.id);

      expect(resumeInfo?.resumeFrom).toBe("START");
      expect(resumeInfo?.lastCheckpoint).toBeUndefined();
    });

    test("resumeTask returns undefined for completed task", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);
      queue.completeTask(task.id);

      const resumeInfo = queue.resumeTask(task.id);

      expect(resumeInfo).toBeUndefined();
    });

    test("recoverTasks returns all in-progress tasks", () => {
      const task1 = queue.addTask("RESEARCH");
      const task2 = queue.addTask("EVALUATE");
      const task3 = queue.addTask("MATCH_BET");

      queue.startTask(task1.id);
      queue.addCheckpoint(task1.id, "MARKETS_FETCHED", {});
      queue.startTask(task2.id);
      // task3 remains PENDING

      // Simulate crash
      const queue2 = new TaskQueue(TEST_QUEUE_PATH);
      const recovered = queue2.recoverTasks();

      expect(recovered.length).toBe(2);
      expect(recovered.map(r => r.task.id)).toContain(task1.id);
      expect(recovered.map(r => r.task.id)).toContain(task2.id);
    });
  });

  describe("Backoff Calculation", () => {
    test("calculateBackoff uses exponential backoff", () => {
      const task: Task = {
        id: "test",
        type: "RESEARCH",
        state: "PENDING",
        checkpoints: [],
        attempts: 1,
        maxAttempts: 5,
        timeout: DEFAULT_TASK_TIMEOUT,
        createdAt: Date.now()
      };

      // Attempt 1: 1 * 2^0 = 1 second
      task.attempts = 1;
      expect(TaskQueue.calculateBackoff(task)).toBe(BASE_BACKOFF_DELAY);

      // Attempt 2: 1 * 2^1 = 2 seconds
      task.attempts = 2;
      expect(TaskQueue.calculateBackoff(task)).toBe(BASE_BACKOFF_DELAY * 2);

      // Attempt 3: 1 * 2^2 = 4 seconds
      task.attempts = 3;
      expect(TaskQueue.calculateBackoff(task)).toBe(BASE_BACKOFF_DELAY * 4);

      // Attempt 4: 1 * 2^3 = 8 seconds
      task.attempts = 4;
      expect(TaskQueue.calculateBackoff(task)).toBe(BASE_BACKOFF_DELAY * 8);
    });

    test("calculateBackoff caps at MAX_BACKOFF_DELAY", () => {
      const task: Task = {
        id: "test",
        type: "RESEARCH",
        state: "PENDING",
        checkpoints: [],
        attempts: 100, // Very high attempt count
        maxAttempts: 200,
        timeout: DEFAULT_TASK_TIMEOUT,
        createdAt: Date.now()
      };

      const delay = TaskQueue.calculateBackoff(task);

      expect(delay).toBe(MAX_BACKOFF_DELAY);
    });
  });

  describe("Timeout Detection", () => {
    test("isTaskTimedOut returns false for fresh task", () => {
      const task: Task = {
        id: "test",
        type: "RESEARCH",
        state: "IN_PROGRESS",
        checkpoints: [],
        attempts: 1,
        maxAttempts: 3,
        timeout: 60000, // 60 seconds
        createdAt: Date.now(),
        startedAt: Date.now()
      };

      expect(TaskQueue.isTaskTimedOut(task)).toBe(false);
    });

    test("isTaskTimedOut returns true for expired task", () => {
      const task: Task = {
        id: "test",
        type: "RESEARCH",
        state: "IN_PROGRESS",
        checkpoints: [],
        attempts: 1,
        maxAttempts: 3,
        timeout: 1000, // 1 second
        createdAt: Date.now() - 5000,
        startedAt: Date.now() - 5000 // Started 5 seconds ago
      };

      expect(TaskQueue.isTaskTimedOut(task)).toBe(true);
    });

    test("isTaskTimedOut returns false if task not IN_PROGRESS", () => {
      const task: Task = {
        id: "test",
        type: "RESEARCH",
        state: "PENDING",
        checkpoints: [],
        attempts: 0,
        maxAttempts: 3,
        timeout: 1000,
        createdAt: Date.now() - 5000
      };

      expect(TaskQueue.isTaskTimedOut(task)).toBe(false);
    });
  });

  describe("Queue Management", () => {
    test("pruneOldTasks removes old completed tasks", () => {
      const task1 = queue.addTask("RESEARCH");
      const task2 = queue.addTask("EVALUATE");

      queue.startTask(task1.id);
      queue.completeTask(task1.id);

      // Manually set old completedAt
      const retrieved = queue.getTask(task1.id);
      if (retrieved) {
        retrieved.completedAt = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      }

      const pruned = queue.pruneOldTasks();

      expect(pruned).toBe(1);
      expect(queue.getStats().total).toBe(1);
      expect(queue.getTask(task1.id)).toBeUndefined();
    });

    test("pruneOldTasks keeps in-progress tasks", () => {
      const task = queue.addTask("RESEARCH");
      queue.startTask(task.id);

      const pruned = queue.pruneOldTasks(0); // Prune everything older than now

      expect(pruned).toBe(0);
      expect(queue.getTask(task.id)).toBeDefined();
    });

    test("clear removes all tasks", () => {
      queue.addTask("RESEARCH");
      queue.addTask("EVALUATE");
      queue.addTask("MATCH_BET");

      queue.clear();

      expect(queue.getStats().total).toBe(0);
    });

    test("getStats returns correct counts", () => {
      const task1 = queue.addTask("RESEARCH");
      const task2 = queue.addTask("EVALUATE");
      const task3 = queue.addTask("MATCH_BET");

      queue.startTask(task1.id);
      queue.completeTask(task1.id);
      queue.startTask(task2.id);

      const stats = queue.getStats();

      expect(stats.total).toBe(3);
      expect(stats.completed).toBe(1);
      expect(stats.inProgress).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(0);
    });
  });
});
