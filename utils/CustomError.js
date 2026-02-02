class CustomError extends Error {
  constructor(statusCode, message, suggestion = null) {
    super(message);
    this.statusCode = statusCode;
    this.suggestion = suggestion;
  }
}
export { CustomError };
