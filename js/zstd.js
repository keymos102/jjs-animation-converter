let zstd = null;


export async function initializeZstd() {
    if (zstd) {
        return;
    }

    // Zstandard implementation will be initialized here.
    //
    // The rest of the application should not know
    // which Zstandard library is being used.
}


export async function decompressZstd(bytes) {
    await initializeZstd();

    if (!zstd) {
        throw new Error("Zstandard decoder is not initialized.");
    }

    return zstd.decompress(bytes);
}


export async function compressZstd(bytes) {
    await initializeZstd();

    if (!zstd) {
        throw new Error("Zstandard encoder is not initialized.");
    }

    return zstd.compress(bytes);
}