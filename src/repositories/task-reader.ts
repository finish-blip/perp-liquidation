import type { TaskId } from "../domain/shared/id.js";
import type { TaskRecord } from "./task-repository.js";

export type TaskReader = {
  findById(id: TaskId): Promise<TaskRecord | undefined>;
};
