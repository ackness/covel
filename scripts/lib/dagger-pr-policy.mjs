export const repository = "ackness/covel";
export const repositoryId = 1190560481;
export const ownerId = 19150500;
export const checkName = "Dagger Linux";

export const isSha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

/** Author identity alone is insufficient: forks never receive engine access. */
export function eligibleOwnerPr(pr) {
  return Boolean(
    pr?.state === "open" &&
    Number.isSafeInteger(pr.number) &&
    pr.number > 0 &&
    pr.user?.id === ownerId &&
    pr.user?.login === "ackness" &&
    pr.head?.repo?.id === repositoryId &&
    pr.head.repo.full_name === repository &&
    pr.base?.repo?.id === repositoryId &&
    pr.base.repo.full_name === repository &&
    pr.base.ref === "main" &&
    isSha(pr.head.sha) &&
    isSha(pr.base.sha),
  );
}

export function checkIdentity(prNumber, mergeSha) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !isSha(mergeSha))
    throw new Error("Invalid PR check identity");
  return `covel-dagger:${prNumber}:${mergeSha}`;
}

/** A green result for a different base/merge revision cannot satisfy this PR. */
export function remoteCheckState(checks, externalId) {
  const matching = checks
    .filter(
      (check) =>
        check.name === checkName &&
        check.app?.slug === "github-actions" &&
        check.external_id === externalId,
    )
    .sort((a, b) => b.id - a.id);
  const latest = matching[0];
  if (!latest || latest.status !== "completed") return "pending";
  return latest.conclusion === "success" ? "success" : "failure";
}
