/** Keep AWS credentials and provider configuration out of non-AWS child processes. */
export function withoutAwsProviderEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const name = key.toUpperCase();
      return !name.startsWith("AWS_") && name !== "BOTO_CONFIG";
    }),
  );
}
