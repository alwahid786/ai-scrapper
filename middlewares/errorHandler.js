const errorHandler = (err, req, res, next) => {
  console.log('error from error handler', err);
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  
  const errorResponse = {
    success: false,
    message,
  };
  
  // Include suggestion for 402 Payment Required errors
  if (statusCode === 402 && err.suggestion) {
    errorResponse.suggestion = err.suggestion;
  }
  
  res.status(statusCode).json(errorResponse);
};
export default errorHandler;
