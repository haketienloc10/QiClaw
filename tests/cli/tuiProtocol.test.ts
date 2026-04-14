import { describe, expect, it } from 'vitest';

import {
  parseBridgeMessage,
  serializeBridgeMessage,
  type FrontendAction,
  type HostEvent,
  type TranscriptCell
} from '../../src/cli/tuiProtocol.js';

describe('tuiProtocol', () => {
  it('serializes and parses typed host events as ndjson lines', () => {
    const event: HostEvent = {
      type: 'assistant_delta',
      turnId: 'turn-1',
      messageId: 'msg-1',
      text: 'xin chao'
    };

    const line = serializeBridgeMessage(event);

    expect(line.endsWith('\n')).toBe(true);
    expect(parseBridgeMessage(line)).toEqual(event);
  });

  it('serializes and parses typed frontend actions as ndjson lines', () => {
    const action: FrontendAction = {
      type: 'run_shell_command',
      command: 'git',
      args: ['status', '--short']
    };

    expect(parseBridgeMessage(serializeBridgeMessage(action))).toEqual(action);
  });

  it('accepts transcript seed and append payloads only when transcript cells are well formed', () => {
    const cells: TranscriptCell[] = [
      { id: 'user-1', kind: 'user', text: 'hello' },
      { id: 'tool-1', kind: 'tool', text: 'done', toolName: 'shell', title: 'pwd', isError: false }
    ];

    expect(parseBridgeMessage(serializeBridgeMessage({ type: 'transcript_seed', cells }))).toEqual({
      type: 'transcript_seed',
      cells
    });
    expect(parseBridgeMessage(serializeBridgeMessage({ type: 'transcript_append', cells }))).toEqual({
      type: 'transcript_append',
      cells
    });
  });

  it('rejects malformed bridge payloads', () => {
    expect(() => parseBridgeMessage('{"type":"assistant_delta"}\n')).toThrow(/invalid bridge message/i);
    expect(() => parseBridgeMessage('not json\n')).toThrow(/invalid bridge message/i);
    expect(() => parseBridgeMessage('{"type":"transcript_seed","cells":[{"id":1,"kind":"user","text":"x"}]}\n')).toThrow(/invalid bridge message/i);
    expect(() => parseBridgeMessage('{"type":"run_shell_command","command":"git","args":["status",1]}\n')).toThrow(/invalid bridge message/i);
    expect(() => parseBridgeMessage('{"type":"tool_completed","turnId":"t","toolCallId":"c","toolName":"shell","status":"done","resultPreview":"ok"}\n')).toThrow(/invalid bridge message/i);
  });
});
