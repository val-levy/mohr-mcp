/** One JSON object per line on stdout, where the host collects logs. */
export type Log = (entry: Record<string, unknown>) => void;

export const logToStdout: Log = (entry) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
};
