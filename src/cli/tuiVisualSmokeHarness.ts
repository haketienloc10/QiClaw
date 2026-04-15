export interface DeterministicTuiSmokeHarnessOptions {
  repoRoot: string;
  binaryPath: string;
  outputPath: string;
}

export interface DeterministicTuiSmokeHarness {
  command: string;
}

export function createDeterministicTuiSmokeHarness(
  options: DeterministicTuiSmokeHarnessOptions
): DeterministicTuiSmokeHarness {
  const pythonScript = [
    'import json, os, subprocess, threading, time',
    `repo = ${JSON.stringify(options.repoRoot)}`,
    `bin_path = ${JSON.stringify(options.binaryPath)}`,
    'host_read, host_write = os.pipe()',
    'action_read, action_write = os.pipe()',
    '',
    'def send(event):',
    '    os.write(host_write, (json.dumps(event) + "\\n").encode())',
    '',
    'def drain_actions():',
    '    while True:',
    '        try:',
    '            data = os.read(action_read, 4096)',
    '            if not data:',
    '                break',
    '        except OSError:',
    '            break',
    '',
    'threading.Thread(target=drain_actions, daemon=True).start()',
    '',
    'def setup_fds():',
    '    os.dup2(host_read, 3)',
    '    os.dup2(action_write, 4)',
    '',
    'p = subprocess.Popen([bin_path], cwd=repo, stdin=None, stdout=None, stderr=None, pass_fds=(host_read, action_write), preexec_fn=setup_fds)',
    'os.close(host_read)',
    'os.close(action_write)',
    '',
    'send({"type":"hello","protocolVersion":1,"sessionId":"smoke-session","model":"claude-opus-4-6","cwd":repo})',
    'send({"type":"session_loaded","restored":False,"sessionId":"smoke-session"})',
    'send({"type":"slash_catalog","commands":[{"name":"/status","description":"Show status","usage":"/status","kind":"direct"}]})',
    'send({"type":"transcript_seed","cells":[{"id":"user-1","kind":"user","text":"xin chào","title":"User"},{"id":"assistant-1","kind":"assistant","text":"Mình sẽ kiểm tra workspace rồi tóm tắt ngắn gọn.","title":"Assistant"}]})',
    'time.sleep(0.8)',
    'send({"type":"tool_started","turnId":"turn-2","toolCallId":"call-1","toolName":"shell","label":"git status"})',
    'time.sleep(1.0)',
    'send({"type":"tool_completed","turnId":"turn-2","toolCallId":"call-1","toolName":"shell","status":"success","resultPreview":"On branch main\\nYour branch is up to date with origin/main.\\nChanges not staged for commit","durationMs":28})',
    'time.sleep(0.6)',
    'send({"type":"assistant_delta","turnId":"turn-2","messageId":"assistant-2","text":"Mình thấy có thay đổi local trong repo."})',
    'time.sleep(0.6)',
    'send({"type":"assistant_completed","turnId":"turn-2","messageId":"assistant-2","text":"Mình thấy có thay đổi local trong repo. Tiếp theo mình có thể rà soát diff hoặc chạy test tập trung."})',
    'time.sleep(2.0)',
    'p.terminate()',
    'try:',
    '    p.wait(timeout=3)',
    'except subprocess.TimeoutExpired:',
    '    p.kill()'
  ].join('\n');

  const escaped = pythonScript.replace(/'/g, `'"'"'`);
  return {
    command: `script -q -c 'python3 - <<'"'"'PY'"'"'\n${escaped}\nPY' ${options.outputPath}`
  };
}
