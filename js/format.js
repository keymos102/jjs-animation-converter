export function detectFormat(text) {
    const value = text.trim();

    if (!value) {
        throw new Error("Input is empty.");
    }

    // Сначала проверяем обычный JSON.
    try {
        JSON.parse(value);
        return "json";
    } catch {
        // Это не JSON.
    }

    // Если JSON не распарсился, пробуем считать
    // строку Base64.
    if (isBase64(value)) {
        return "zstd-base64";
    }

    throw new Error(
        "Unable to determine input format. Expected JSON or Zstandard Base64."
    );
}


function isBase64(value) {
    if (value.length === 0 || value.length % 4 !== 0) {
        return false;
    }

    return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}