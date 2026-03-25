import type { Task } from "../moltlaunch/types.js";

export function buildTaskContext(task: Task): string {
  const parts = [
    `Task ID: ${task.id}`,
    `Status: ${task.status}`,
    `Client: ${task.clientAddress}`,
    `Description: ${task.task}`,
  ];

  if (task.budgetWei) {
    parts.push(`Client budget: ${task.budgetWei} wei`);
  }

  if (task.category) {
    parts.push(`Category: ${task.category}`);
  }

  if (task.quotedPriceWei) {
    parts.push(`Your quoted price: ${task.quotedPriceWei} wei`);
  }

  if (task.result) {
    parts.push(`\nYour previous submission:\n${task.result}`);
  }

  if (task.messages && task.messages.length > 0) {
    const recent = task.messages.slice(-5);
    parts.push(
      "\nRecent messages:",
      ...recent.map((m) => `  [${m.role}] ${m.content}`),
    );
  }

  if (task.revisionCount && task.revisionCount > 0) {
    parts.push(`Revision #${task.revisionCount}`);
  }

  if (task.files && task.files.length > 0) {
    parts.push(
      "\nAttached files:",
      ...task.files.map((f) => `  - ${f.name} (${f.size} bytes)`),
    );
  }

  if (task.status === "requested") {
    parts.push(
      `\nINSTRUCTION: This task is in 'requested' status. Your ONLY allowed action is to call quote_task (or decline_task). Do NOT do any actual work. Do NOT call submit_work. After quoting, the loop ends — wait for the client to accept.`,
    );
  }

  if (task.status === "accepted" || task.status === "revision") {
    parts.push(
      `\nACTION REQUIRED: This task is in '${task.status}' status. You MUST complete the work and call the submit_work tool with the full deliverable. Do NOT output the result as plain text — you must use the submit_work tool.`,
    );
  }

  return parts.join("\n");
}
