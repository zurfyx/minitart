// What the manager needs from GitHub, and nothing else. The real client (client.ts) and the
// fake used by the tests and the demo (testing/fakes.ts) both implement `GitHub`.

export interface Repo {
  /** `owner/name`. */
  fullName: string;
  private: boolean;
}

export type JobStatus = 'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending';

export interface Job {
  id: number;
  runId: number;
  repo: string;
  name: string;
  workflow: string;
  /** The job's `runs-on`. */
  labels: string[];
  status: JobStatus;
  conclusion: string | null;
  /** The runner that took the job. minitart names a runner after its VM. */
  runnerName: string | null;
  url: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GitHub {
  /** The repos the App is installed on: the allowlist (D03). */
  repos(): Promise<Repo[]>;
  /** Ids of the workflow runs that have not completed. */
  activeRuns(repo: string): Promise<number[]>;
  jobs(repo: string, runId: number): Promise<Job[]>;
  /** A runner that exists for one job: its id, and the secret that starts it. */
  registerRunner(
    repo: string,
    name: string,
    labels: string[],
  ): Promise<{ runnerId: number; jitConfig: string }>;
  removeRunner(repo: string, runnerId: number): Promise<void>;
  /** The log of a finished job. */
  jobLog(repo: string, jobId: number): Promise<string>;
}

export class GitHubError extends Error {
  readonly status: number;
  /** When the rate limit resets, if that is why the request failed. */
  readonly retryAt: number | null;

  constructor(status: number, message: string, retryAt: number | null = null) {
    super(message);
    this.status = status;
    this.retryAt = retryAt;
  }
}
