import type { Task } from "../moltlaunch/types.js";

function weiToEth(wei: string): string {
  try {
    const eth = Number(BigInt(wei)) / 1e18;
    return `${eth.toFixed(5)} ETH`;
  } catch {
    return `${wei} wei`;
  }
}

export function buildTaskContext(task: Task): string {
  const parts = [
    `Task ID: ${task.id}`,
    `Status: ${task.status}`,
    `Client: ${task.clientAddress}`,
    `Description:\n${task.task}`,
  ];

  if (task.budgetWei) {
    const ethAmt = weiToEth(task.budgetWei);
    parts.push(`Client budget: ${ethAmt} — price at or below this to be competitive`);
  }

  if (task.category) {
    parts.push(`Category: ${task.category}`);
  }

  if (task.quotedPriceWei) {
    parts.push(`Your quoted price: ${weiToEth(task.quotedPriceWei)}`);
  }

  if (task.revisionCount && task.revisionCount > 0) {
    parts.push(`⚠️ Revision #${task.revisionCount} — client was not fully satisfied. Read their feedback carefully and address EVERY point.`);
  }

  if (task.messages && task.messages.length > 0) {
    const recent = task.messages.slice(-8);
    parts.push(
      "\nConversation history:",
      ...recent.map((m) => `  [${m.role.toUpperCase()}] ${m.content}`),
    );
  }

  if (task.result) {
    parts.push(`\nYour previous submission (improve this for revision):\n${task.result}`);
  }

  if (task.files && task.files.length > 0) {
    parts.push(
      "\nAttached files:",
      ...task.files.map((f) => `  - ${f.name} (${(f.size / 1024).toFixed(1)} KB)`),
    );
  }

  return parts.join("\n");
}
