/** A failure that will not go away by retrying (bad request, missing object, unknown job kind). */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError';
}

/** Thrown inside the pipeline when the uploaded file itself is unacceptable; the video is rejected, not retried. */
export class MediaRejection extends Error {
  override name = 'MediaRejection';
  constructor(readonly reason: string) {
    super(reason);
  }
}
