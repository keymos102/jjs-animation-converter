import { detectFormat } from "./format.js";

import {
    decompressZstd,
    compressZstd
} from "./zstd.js";

import { parseRBXM } from "./rbxm.js";


const rbxmInput =
    document.getElementById("rbxmInput");

const sourceInput =
    document.getElementById("sourceInput");

const offsetXInput =
    document.getElementById("offsetX");

const offsetYInput =
    document.getElementById("offsetY");

const offsetZInput =
    document.getElementById("offsetZ");

const convertButton =
    document.getElementById("convertButton");

const copyButton =
    document.getElementById("copyButton");

const outputInput =
    document.getElementById("outputInput");

const status =
    document.getElementById("status");


// ============================================================
// RBXM file selection
// ============================================================

rbxmInput.addEventListener(
    "change",
    handleRBXMSelection
);


// ============================================================
// Convert button
// ============================================================

convertButton.addEventListener(
    "click",
    convert
);


// ============================================================
// Copy button
// ============================================================

copyButton.addEventListener(
    "click",
    async () => {

        if (!outputInput.value) {
            return;
        }

        try {
            await navigator.clipboard.writeText(
                outputInput.value
            );

            setStatus("Copied.");
        }

        catch (error) {
            console.error(error);

            setStatus(
                "Unable to copy result."
            );
        }
    }
);


// ============================================================
// RBXM selection
// ============================================================

async function handleRBXMSelection() {

    const file =
        rbxmInput.files[0];

    if (!file) {
        return;
    }

    try {
        setStatus(
            "Reading RBXM..."
        );

        const rbxm =
            await parseRBXM(file);

        showRBXMInfo(rbxm);

        setStatus(
            "RBXM loaded successfully."
        );
    }

    catch (error) {
        console.error(error);

        setStatus(
            `RBXM error: ${error.message}`
        );
    }
}


// ============================================================
// Display RBXM information
// ============================================================

function showRBXMInfo(rbxm) {

    console.log(
        "========== RBXM =========="
    );

    console.log(
        "Model:",
        rbxm.model
    );

    console.log(
        "Humanoid:",
        rbxm.humanoid
    );

    console.log(
        "KeyframeSequence:",
        rbxm.keyframeSequence
    );

    console.log(
        "Keyframes:",
        rbxm.keyframes
    );

    console.log(
        "Pose count:",
        rbxm.poses.length
    );

    console.log(
        "All instances:",
        rbxm.instances
    );

    console.log(
        "=========================="
    );

    const modelName =
        rbxm.model?.name ??
        "(not found)";

    const humanoidName =
        rbxm.humanoid?.name ??
        "(not found)";

    const sequenceName =
        rbxm.keyframeSequence?.name ??
        "(not found)";

    const keyframeCount =
        rbxm.keyframes.length;

    const poseCount =
        rbxm.poses.length;

    setStatus(
        [
            "RBXM loaded.",
            `Model: ${modelName}`,
            `Humanoid: ${humanoidName}`,
            `KeyframeSequence: ${sequenceName}`,
            `Keyframes: ${keyframeCount}`,
            `Poses: ${poseCount}`
        ].join(" | ")
    );
}


// ============================================================
// Main conversion
// ============================================================

async function convert() {

    try {

        // ----------------------------------------------------
        // 1. RBXM
        // ----------------------------------------------------

        const rbxmFile =
            rbxmInput.files[0];

        if (!rbxmFile) {
            throw new Error(
                "Please select an RBXM file."
            );
        }

        setStatus(
            "Reading RBXM..."
        );

        const rbxm =
            await parseRBXM(
                rbxmFile
            );


        // ----------------------------------------------------
        // 2. Source text
        // ----------------------------------------------------

        const source =
            sourceInput.value.trim();

        if (!source) {
            throw new Error(
                "Please enter JSON or Zstandard Base64."
            );
        }


        // ----------------------------------------------------
        // 3. Detect format
        // ----------------------------------------------------

        const format =
            detectFormat(source);

        console.log(
            "Detected format:",
            format
        );


        // ----------------------------------------------------
        // 4. Convert input to JSON
        // ----------------------------------------------------

        let inputJSON;

        if (format === "json") {

            inputJSON =
                JSON.parse(source);
        }

        else if (
            format === "zstd-base64"
        ) {

            inputJSON =
                await decodeZstdBase64(
                    source
                );
        }

        else {

            throw new Error(
                "Unsupported input format."
            );
        }


        // ----------------------------------------------------
        // 5. Read animation offset
        // ----------------------------------------------------

        const offset = {
            x: readNumber(
                offsetXInput.value
            ),

            y: readNumber(
                offsetYInput.value
            ),

            z: readNumber(
                offsetZInput.value
            )
        };


        // ----------------------------------------------------
        // 6. Convert animation
        // ----------------------------------------------------

        setStatus(
            "Converting animation..."
        );

        const resultJSON =
            convertAnimation(
                rbxm,
                inputJSON,
                offset
            );


        // ----------------------------------------------------
        // 7. JSON → UTF-8
        // ----------------------------------------------------

        const resultText =
            JSON.stringify(
                resultJSON
            );

        const encoder =
            new TextEncoder();

        const jsonBytes =
            encoder.encode(
                resultText
            );


        // ----------------------------------------------------
        // 8. UTF-8 → Zstandard
        // ----------------------------------------------------

        setStatus(
            "Compressing result..."
        );

        const compressed =
            await compressZstd(
                jsonBytes
            );


        // ----------------------------------------------------
        // 9. Zstandard → Base64
        // ----------------------------------------------------

        const base64 =
            bytesToBase64(
                compressed
            );

        outputInput.value =
            base64;


        // ----------------------------------------------------
        // 10. Finished
        // ----------------------------------------------------

        setStatus(
            "Conversion completed."
        );

    }

    catch (error) {

        console.error(error);

        setStatus(
            `Error: ${error.message}`
        );
    }
}


// ============================================================
// Zstandard Base64 → JSON
// ============================================================

async function decodeZstdBase64(
    base64
) {

    const compressed =
        base64ToBytes(
            base64
        );

    const decompressed =
        await decompressZstd(
            compressed
        );

    const decoder =
        new TextDecoder();

    const jsonText =
        decoder.decode(
            decompressed
        );

    try {
        return JSON.parse(
            jsonText
        );
    }

    catch {
        throw new Error(
            "Zstandard data was decompressed, " +
            "but the result is not valid JSON."
        );
    }
}


// ============================================================
// Animation conversion
// ============================================================

function convertAnimation(
    rbxm,
    inputJSON,
    offset
) {

    /*
     * IMPORTANT:
     *
     * This is intentionally not the final
     * JJS conversion yet.
     *
     * At this stage we have successfully
     * connected:
     *
     * RBXM
     *   ↓
     * Model
     *   ↓
     * Humanoid
     *   ↓
     * KeyframeSequence
     *   ↓
     * Keyframe
     *   ↓
     * Pose
     *
     * The actual JJS block generation
     * will be implemented next.
     */


    console.log(
        "========== CONVERSION =========="
    );

    console.log(
        "RBXM:",
        rbxm
    );

    console.log(
        "Input JSON:",
        inputJSON
    );

    console.log(
        "Animation offset:",
        offset
    );

    console.log(
        "Keyframes:",
        rbxm.keyframes
    );

    console.log(
        "================================"
    );


    /*
     * Temporary result.
     *
     * For now we preserve the input JSON.
     * The next conversion stage will replace
     * this with generated JJS animation data.
     */

    return inputJSON;
}


// ============================================================
// Base64
// ============================================================

function bytesToBase64(
    bytes
) {

    let binary = "";

    const chunkSize =
        0x8000;

    for (
        let i = 0;
        i < bytes.length;
        i += chunkSize
    ) {

        const chunk =
            bytes.subarray(
                i,
                Math.min(
                    i + chunkSize,
                    bytes.length
                )
            );

        binary +=
            String.fromCharCode(
                ...chunk
            );
    }

    return btoa(binary);
}


function base64ToBytes(
    base64
) {

    const binary =
        atob(base64);

    const bytes =
        new Uint8Array(
            binary.length
        );

    for (
        let i = 0;
        i < binary.length;
        i++
    ) {

        bytes[i] =
            binary.charCodeAt(i);
    }

    return bytes;
}


// ============================================================
// Number
// ============================================================

function readNumber(value) {

    const number =
        Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return number;
}


// ============================================================
// Status
// ============================================================

function setStatus(
    message
) {
    status.textContent =
        message;
}