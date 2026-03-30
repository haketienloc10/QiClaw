import { getTool } from '../tools/registry.js';
import type { ToolContext } from '../tools/tool.js';
import { toToolErrorMessage, toToolResultMessage, type ToolCallRequest, type ToolResultMessage } from '../provider/model.js';

export async function dispatchToolCall(
  toolCall: ToolCallRequest,
  context: ToolContext
): Promise<ToolResultMessage> {
  const tool = getTool(toolCall.name);

  if (!tool) {
    return toToolErrorMessage(toolCall, new Error(`Tool not found: ${toolCall.name}`));
  }

  try {
    const result = await tool.execute(toolCall.input, context);
    return toToolResultMessage(toolCall, result);
  } catch (error) {
    return toToolErrorMessage(toolCall, error);
  }
}
