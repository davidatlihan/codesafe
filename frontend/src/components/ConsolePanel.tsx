import { useMemo, useState } from 'react';

type RunLanguage = 'javascript' | 'python';

type ActiveFileContext = {
  fileId: string;
  fileName: string;
  language: RunLanguage;
  content: string;
};

type ConsolePanelProps = {
  apiBaseUrl: string;
  token: string;
  projectId: string;
  activeFile: ActiveFileContext | null;
  role: 'viewer' | 'editor' | 'admin';
};

type RunResponse = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
};

function formatTimestamp(): string {
  return new Date().toLocaleTimeString();
}

export default function ConsolePanel({
  apiBaseUrl,
  token,
  projectId,
  activeFile,
  role
}: ConsolePanelProps) {
  const [output, setOutput] = useState<string>('');
  const [isRunning, setIsRunning] = useState(false);
  const canRun = role === 'editor' || role === 'admin';

  const runLabel = useMemo(() => {
    if (!activeFile) {
      return 'No active file';
    }
    return `${activeFile.fileName} (${activeFile.language})`;
  }, [activeFile]);

  const appendOutput = (text: string): void => {
    setOutput((current) => {
      if (!current) {
        return text;
      }
      return `${current}\n${text}`;
    });
  };

  const handleRun = async (): Promise<void> => {
    if (!activeFile || !canRun || isRunning) {
      return;
    }

    setIsRunning(true);
    appendOutput(`[${formatTimestamp()}] Running ${activeFile.fileName}`);
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/projects/${encodeURIComponent(projectId)}/run`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            fileName: activeFile.fileName,
            language: activeFile.language,
            code: activeFile.content
          })
        }
      );

      const responseText = await response.text();
      let parsed: RunResponse | null = null;
      try {
        parsed = responseText ? (JSON.parse(responseText) as RunResponse) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const message = parsed?.stderr || responseText || `Run failed (${response.status})`;
        appendOutput(`[${formatTimestamp()}] ERROR: ${message}`);
        return;
      }

      const stdout = parsed?.stdout ?? '';
      const stderr = parsed?.stderr ?? '';
      const exitCode = parsed?.exitCode ?? 0;
      const timedOut = Boolean(parsed?.timedOut);

      appendOutput(
        `[${formatTimestamp()}] Exit ${exitCode}${timedOut ? ' (timeout)' : ''}`
      );
      if (stdout.trim().length > 0) {
        appendOutput(`stdout:\n${stdout}`);
      }
      if (stderr.trim().length > 0) {
        appendOutput(`stderr:\n${stderr}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Run request failed';
      appendOutput(`[${formatTimestamp()}] ERROR: ${message}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="console-panel">
      <div className="console-toolbar">
        <span>{runLabel}</span>
        <div className="console-actions">
          <button type="button" onClick={() => void handleRun()} disabled={!activeFile || !canRun || isRunning}>
            {isRunning ? 'Running...' : 'Run'}
          </button>
          <button type="button" onClick={() => setOutput('')}>
            Clear
          </button>
        </div>
      </div>
      <div className="console-warning">Note: for console runs, click a file tab twice before running.</div>
      <pre className="console-output">{output || 'Console output will appear here.'}</pre>
    </div>
  );
}
