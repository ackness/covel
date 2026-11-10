/**
 * Test-only entry: helpers that reset process-wide transport state between
 * tests in other workspaces. Production code must not import it.
 */
export { resetOutboundProxyForTests } from "./outbound-network.js";
