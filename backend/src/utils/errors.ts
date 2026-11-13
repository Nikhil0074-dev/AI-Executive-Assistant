export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export class CalendarDisconnectedError extends Error {
  constructor(message = 'Google Calendar is disconnected') {
    super(message);
  }
}
