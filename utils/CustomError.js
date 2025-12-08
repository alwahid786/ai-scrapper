class CustomError extends Error {
  constructor(satatuSCode, message) {
    super(message);
    this.satatuSCode = satatuSCode;
  }
}
export { CustomError };
