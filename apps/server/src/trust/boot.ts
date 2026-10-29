/** A damaged installed package must never prevent the instance from booting. */
export async function verifyTrustedSourcesAtBoot(trust: {
  verifyAll(): Promise<void>;
}): Promise<void> {
  try {
    await trust.verifyAll();
  } catch (error) {
    console.warn("[trusted-sources] Boot verification failed:", error);
  }
}
