// Log operational metadata, never request bodies, authorization headers, or credentials.
export const logger = {
  info(message: string) {
    console.info(
      JSON.stringify({
        level: 'info',
        message,
        timestamp: new Date().toISOString(),
      }),
    );
  },
  error(message: string) {
    console.error(
      JSON.stringify({
        level: 'error',
        message,
        timestamp: new Date().toISOString(),
      }),
    );
  },
};
