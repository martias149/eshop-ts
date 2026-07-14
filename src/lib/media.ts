export async function putImage(
  bucket: R2Bucket,
  key: string,
  file: File | ReadableStream,
  contentType?: string,
): Promise<void> {
  const type = contentType ?? (file instanceof File ? file.type : undefined);
  await bucket.put(key, file, {
    httpMetadata: { contentType: type },
  });
}

export async function deleteImage(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

export function mediaUrl(key: string): string {
  return "/media/" + key;
}

export function productImageKey(productId: number, originalFilename: string): string {
  const sanitized = originalFilename.replace(/[\\/]/g, "_");
  return "products/" + crypto.randomUUID() + "-" + sanitized;
}
