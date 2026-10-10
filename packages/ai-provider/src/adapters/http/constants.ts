export const ERROR_PREVIEW_MAX_CHARS = 200;

/**
 * Safety ceilings for one provider response body. They stop a faulty or
 * hostile endpoint from filling memory; they are not quotas, and each sits
 * far above the largest legitimate answer.
 *
 * A JSON body can carry several base64 images (an image wire returns all `n`
 * of them in one document). 256 MiB holds about 190 MiB of image bytes and is
 * half of the longest string the JavaScript engine can build, so a body the
 * ceiling rejects is one that could barely be parsed at all. One server-sent
 * event is one JSON document and has the same ceiling.
 */
export const MAX_JSON_RESPONSE_BYTES = 256 * 1024 * 1024;

/**
 * A binary body is one media asset (synthesized audio). The ceiling equals
 * the default limit of media ingest for one asset.
 */
export const MAX_BINARY_RESPONSE_BYTES = 50 * 1024 * 1024;
