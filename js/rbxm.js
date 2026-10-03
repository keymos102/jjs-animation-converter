"use strict";

/*
 * JJS Animation Converter
 * Binary RBXM reader
 *
 * No npm.
 * No external libraries.
 *
 * Current scope:
 * - Binary .rbxm
 * - INST
 * - PROP
 * - PRNT
 * - META
 * - SSTR
 * - KeyframeSequence
 * - Keyframe
 * - Pose
 * - R6 / R15 animation hierarchy
 *
 * Intentionally ignored:
 * - Accessory
 * - Shirt
 * - Pants
 * - Hair
 * - MeshPart geometry
 *
 * Compression:
 * - uncompressed chunks: supported
 * - LZ4 chunks: supported
 * - ZSTD chunks: detected, but requires an external decoder
 */


/* =========================================================
 * PUBLIC API
 * ======================================================= */

async function parseRBXM(file) {
    if (!(file instanceof Blob)) {
        throw new TypeError(
            "parseRBXM(file): file must be a File or Blob."
        );
    }

    const buffer = await file.arrayBuffer();

    return parseRBXMBuffer(buffer);
}


function parseRBXMBuffer(buffer) {
    const reader = new BinaryReader(buffer);

    const header = readHeader(reader);

    const chunks = [];

    let reachedEnd = false;

    while (!reader.eof()) {
        const chunk = readChunk(reader);

        if (!chunk) {
            break;
        }

        chunks.push(chunk);

        if (chunk.name === "END") {
            reachedEnd = true;
            break;
        }
    }

    if (!reachedEnd) {
        throw new Error(
            "RBXM file ended before END chunk."
        );
    }

    const parsed = parseChunks(
        chunks,
        header
    );

    const instances = buildInstanceTree(parsed);

    const character = extractCharacter(
        instances
    );

    const animation = extractAnimation(
        instances
    );

    return {
        format: "RBXM",
        version: header.version,

        header,

        chunks,

        instances,

        character,

        animation,

        warnings: parsed.warnings
    };
}


/* =========================================================
 * BINARY READER
 * ======================================================= */

class BinaryReader {

    constructor(buffer) {
        this.buffer = buffer;

        this.bytes = new Uint8Array(buffer);

        this.view = new DataView(buffer);

        this.offset = 0;
    }


    eof() {
        return this.offset >= this.bytes.length;
    }


    remaining() {
        return this.bytes.length - this.offset;
    }


    ensure(length) {
        if (
            this.offset + length >
            this.bytes.length
        ) {
            throw new Error(
                "Unexpected end of RBXM data."
            );
        }
    }


    seek(position) {
        if (
            position < 0 ||
            position > this.bytes.length
        ) {
            throw new Error(
                "Invalid binary reader position."
            );
        }

        this.offset = position;
    }


    skip(length) {
        this.ensure(length);

        this.offset += length;
    }


    u8() {
        this.ensure(1);

        const value =
            this.view.getUint8(this.offset);

        this.offset += 1;

        return value;
    }


    i8() {
        this.ensure(1);

        const value =
            this.view.getInt8(this.offset);

        this.offset += 1;

        return value;
    }


    u16() {
        this.ensure(2);

        const value =
            this.view.getUint16(
                this.offset,
                true
            );

        this.offset += 2;

        return value;
    }


    i16() {
        this.ensure(2);

        const value =
            this.view.getInt16(
                this.offset,
                true
            );

        this.offset += 2;

        return value;
    }


    u32() {
        this.ensure(4);

        const value =
            this.view.getUint32(
                this.offset,
                true
            );

        this.offset += 4;

        return value;
    }


    i32() {
        this.ensure(4);

        const value =
            this.view.getInt32(
                this.offset,
                true
            );

        this.offset += 4;

        return value;
    }


    f32() {
        this.ensure(4);

        const value =
            this.view.getFloat32(
                this.offset,
                true
            );

        this.offset += 4;

        return value;
    }


    f64() {
        this.ensure(8);

        const value =
            this.view.getFloat64(
                this.offset,
                true
            );

        this.offset += 8;

        return value;
    }


    bytesArray(length) {
        this.ensure(length);

        const value =
            this.bytes.slice(
                this.offset,
                this.offset + length
            );

        this.offset += length;

        return value;
    }


    string(length) {
        return new TextDecoder(
            "utf-8"
        ).decode(
            this.bytesArray(length)
        );
    }


    remainingBytes() {
        return this.bytes.slice(
            this.offset
        );
    }
}


/* =========================================================
 * HEADER
 * ======================================================= */

function readHeader(reader) {

    const magic = reader.string(8);

    if (magic !== "<roblox!") {
        throw new Error(
            "This file is not a Binary RBXM file."
        );
    }


    const signature =
        reader.bytesArray(6);

    const expected = [
        0x89,
        0xff,
        0x0d,
        0x0a,
        0x1a,
        0x0a
    ];


    for (
        let i = 0;
        i < expected.length;
        i++
    ) {
        if (
            signature[i] !==
            expected[i]
        ) {
            throw new Error(
                "Invalid RBXM signature."
            );
        }
    }


    const version = reader.u16();

    if (version !== 0) {
        throw new Error(
            `Unsupported RBXM version: ${version}`
        );
    }


    const classCount = reader.i32();

    const instanceCount = reader.i32();

    const reserved =
        reader.bytesArray(8);


    return {
        version,
        classCount,
        instanceCount,
        reserved
    };
}


/* =========================================================
 * CHUNKS
 * ======================================================= */

function readChunk(reader) {

    if (reader.remaining() < 16) {
        return null;
    }


    const nameBytes =
        reader.bytesArray(4);

    let name = "";

    for (const byte of nameBytes) {
        if (byte !== 0) {
            name += String.fromCharCode(
                byte
            );
        }
    }


    const compressedLength =
        reader.u32();

    const uncompressedLength =
        reader.u32();

    reader.u32(); // reserved


    const storedData =
        reader.bytesArray(
            compressedLength ||
            uncompressedLength
        );


    let data;


    if (compressedLength === 0) {

        data = storedData;

    } else {

        data =
            decompressChunk(
                storedData,
                uncompressedLength,
                name
            );
    }


    return {
        name,

        compressedLength,

        uncompressedLength,

        data
    };
}


/* =========================================================
 * COMPRESSION
 * ======================================================= */

function decompressChunk(
    data,
    expectedLength,
    chunkName
) {

    if (
        data.length >= 4 &&
        data[0] === 0x28 &&
        data[1] === 0xb5 &&
        data[2] === 0x2f &&
        data[3] === 0xfd
    ) {

        throw new Error(
            `Chunk "${chunkName}" uses ZSTD compression. ` +
            `This pure browser version does not include a ZSTD decoder.`
        );
    }


    return decompressLZ4(
        data,
        expectedLength
    );
}


/*
 * Raw LZ4 block decompressor.
 *
 * RBXM uses raw LZ4 blocks, not LZ4 frames.
 */

function decompressLZ4(
    input,
    expectedLength
) {

    const output =
        new Uint8Array(
            expectedLength
        );


    let src = 0;

    let dst = 0;


    while (
        src < input.length
    ) {

        const token =
            input[src++];


        let literalLength =
            token >> 4;


        if (
            literalLength === 15
        ) {

            let value;

            do {

                if (
                    src >= input.length
                ) {
                    throw new Error(
                        "Invalid LZ4 literal length."
                    );
                }

                value =
                    input[src++];

                literalLength += value;

            } while (
                value === 255
            );
        }


        if (
            src + literalLength >
            input.length
        ) {
            throw new Error(
                "Invalid LZ4 literal block."
            );
        }


        output.set(
            input.subarray(
                src,
                src + literalLength
            ),
            dst
        );


        src += literalLength;

        dst += literalLength;


        if (
            src >= input.length
        ) {
            break;
        }


        if (
            src + 2 >
            input.length
        ) {
            throw new Error(
                "Invalid LZ4 match offset."
            );
        }


        const offset =
            input[src] |
            (input[src + 1] << 8);

        src += 2;


        if (
            offset === 0 ||
            offset > dst
        ) {
            throw new Error(
                "Invalid LZ4 match offset."
            );
        }


        let matchLength =
            token & 0x0f;


        if (
            matchLength === 15
        ) {

            let value;

            do {

                if (
                    src >= input.length
                ) {
                    throw new Error(
                        "Invalid LZ4 match length."
                    );
                }

                value =
                    input[src++];

                matchLength += value;

            } while (
                value === 255
            );
        }


        matchLength += 4;


        const matchStart =
            dst - offset;


        for (
            let i = 0;
            i < matchLength;
            i++
        ) {

            if (
                dst >= output.length
            ) {
                throw new Error(
                    "LZ4 decompression exceeded expected size."
                );
            }

            output[dst++] =
                output[
                    matchStart + i
                ];
        }
    }


    if (
        dst !== expectedLength
    ) {
        throw new Error(
            `LZ4 decompression size mismatch: ` +
            `${dst} != ${expectedLength}`
        );
    }


    return output;
}


/* =========================================================
 * CHUNK PARSING
 * ======================================================= */

function parseChunks(
    chunks,
    header
) {

    const classes =
        new Map();

    const properties = [];

    const parents = [];

    const metadata = {};

    const sharedStrings = [];

    const warnings = [];


    for (const chunk of chunks) {

        switch (chunk.name) {

            case "META":
                parseMETA(
                    chunk.data,
                    metadata
                );
                break;


            case "SSTR":
                parseSSTR(
                    chunk.data,
                    sharedStrings
                );
                break;


            case "INST": {

                const inst =
                    parseINST(
                        chunk.data
                    );

                classes.set(
                    inst.classId,
                    inst
                );

                break;
            }


            case "PROP":

                properties.push(
                    parsePROP(
                        chunk.data,
                        classes
                    )
                );

                break;


            case "PRNT":

                parents.push(
                    parsePRNT(
                        chunk.data
                    )
                );

                break;


            case "END":
                break;


            default:

                warnings.push(
                    `Unsupported RBXM chunk: ${chunk.name}`
                );

                break;
        }
    }


    return {
        header,
        classes,
        properties,
        parents,
        metadata,
        sharedStrings,
        warnings
    };
}


/* =========================================================
 * META
 * ======================================================= */

function parseMETA(
    bytes,
    metadata
) {

    const reader =
        new BinaryReader(
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset +
                bytes.byteLength
            )
        );


    const count =
        reader.u32();


    for (
        let i = 0;
        i < count;
        i++
    ) {

        const key =
            readStringValue(reader);

        const value =
            readStringValue(reader);

        metadata[key] = value;
    }
}


/* =========================================================
 * SSTR
 * ======================================================= */

function parseSSTR(
    bytes,
    sharedStrings
) {

    const reader =
        new BinaryReader(
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset +
                bytes.byteLength
            )
        );


    reader.u32(); // version

    const count =
        reader.u32();


    for (
        let i = 0;
        i < count;
        i++
    ) {

        reader.bytesArray(16);

        sharedStrings.push(
            readStringValue(reader)
        );
    }
}


/* =========================================================
 * INST
 * ======================================================= */

function parseINST(bytes) {

    const reader =
        new BinaryReader(
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset +
                bytes.byteLength
            )
        );


    const classId =
        reader.u32();


    const className =
        readStringValue(reader);


    const objectFormat =
        reader.u8();


    const count =
        reader.u32();


    const referents =
        readInterleavedInt32(
            reader,
            count,
            true
        );


    const serviceMarkers = [];


    if (objectFormat === 1) {

        for (
            let i = 0;
            i < count;
            i++
        ) {

            serviceMarkers.push(
                reader.u8()
            );
        }
    }


    return {
        classId,

        className,

        objectFormat,

        count,

        referents,

        serviceMarkers
    };
}


/* =========================================================
 * PROP
 * ======================================================= */

function parsePROP(
    bytes,
    classes
) {

    const reader =
        new BinaryReader(
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset +
                bytes.byteLength
            )
        );


    const classId =
        reader.u32();


    const propertyName =
        readStringValue(reader);


    const typeId =
        reader.u8();


    const classInfo =
        classes.get(classId);


    if (!classInfo) {

        throw new Error(
            `PROP references unknown class ID ${classId}.`
        );
    }


    const count =
        classInfo.count;


    const values =
        readPropertyValues(
            reader,
            typeId,
            count
        );


    return {
        classId,

        className:
            classInfo.className,

        propertyName,

        typeId,

        values
    };
}


/* =========================================================
 * PRNT
 * ======================================================= */

function parsePRNT(bytes) {

    const reader =
        new BinaryReader(
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset +
                bytes.byteLength
            )
        );


    const version =
        reader.u8();


    if (version !== 0) {

        throw new Error(
            `Unsupported PRNT version: ${version}`
        );
    }


    const count =
        reader.u32();


    const children =
        readInterleavedInt32(
            reader,
            count,
            true
        );


    const parents =
        readInterleavedInt32(
            reader,
            count,
            true
        );


    return {
        children,
        parents
    };
}


/* =========================================================
 * INSTANCE TREE
 * ======================================================= */

function buildInstanceTree(parsed) {

    const instances =
        new Map();


    /*
     * First create all instances.
     */

    for (
        const classInfo
        of parsed.classes.values()
    ) {

        for (
            let i = 0;
            i < classInfo.count;
            i++
        ) {

            const referent =
                classInfo.referents[i];


            instances.set(
                referent,
                {
                    referent,

                    classId:
                        classInfo.classId,

                    className:
                        classInfo.className,

                    name:
                        classInfo.className,

                    properties: {},

                    parent: null,

                    children: []
                }
            );
        }
    }


    /*
     * Apply properties.
     */

    for (
        const prop
        of parsed.properties
    ) {

        const classInfo =
            parsed.classes.get(
                prop.classId
            );


        if (!classInfo) {
            continue;
        }


        for (
            let i = 0;
            i < prop.values.length;
            i++
        ) {

            const referent =
                classInfo.referents[i];


            const instance =
                instances.get(
                    referent
                );


            if (!instance) {
                continue;
            }


            instance.properties[
                prop.propertyName
            ] = prop.values[i];


            /*
             * Roblox Instance.Name
             */

            if (
                prop.propertyName ===
                "Name"
            ) {

                instance.name =
                    prop.values[i];
            }
        }
    }


    /*
     * Apply parent relationships.
     */

    for (
        const parentChunk
        of parsed.parents
    ) {

        for (
            let i = 0;
            i < parentChunk.children.length;
            i++
        ) {

            const childRef =
                parentChunk.children[i];

            const parentRef =
                parentChunk.parents[i];


            const child =
                instances.get(
                    childRef
                );


            if (!child) {
                continue;
            }


            if (
                parentRef !== -1
            ) {

                const parent =
                    instances.get(
                        parentRef
                    );


                if (parent) {

                    child.parent =
                        parent;

                    parent.children.push(
                        child
                    );
                }

            } else {

                child.parent = null;
            }
        }
    }


    return Array.from(
        instances.values()
    );
}


/* =========================================================
 * CHARACTER
 * ======================================================= */

function extractCharacter(
    instances
) {

    const models =
        instances.filter(
            instance =>
                instance.className ===
                "Model"
        );


    const humanoids =
        instances.filter(
            instance =>
                instance.className ===
                "Humanoid"
        );


    let model = null;


    if (humanoids.length > 0) {

        let current =
            humanoids[0].parent;


        while (current) {

            if (
                current.className ===
                "Model"
            ) {

                model = current;

                break;
            }

            current =
                current.parent;
        }
    }


    if (!model && models.length > 0) {
        model = models[0];
    }


    if (!model) {

        return {
            found: false,

            model: null,

            humanoid: null,

            bodyParts: []
        };
    }


    const humanoid =
        model.children.find(
            child =>
                child.className ===
                "Humanoid"
        ) || null;


    const bodyParts = [];


    for (
        const child
        of model.children
    ) {

        if (
            isBodyPart(
                child
            )
        ) {

            bodyParts.push(
                child
            );
        }
    }


    return {
        found: true,

        model,

        humanoid,

        bodyParts
    };
}


/* =========================================================
 * BODY PART DETECTION
 * ======================================================= */

function isBodyPart(
    instance
) {

    const className =
        instance.className;


    if (
        className !== "Part" &&
        className !== "MeshPart"
    ) {
        return false;
    }


    return true;
}


/* =========================================================
 * ANIMATION EXTRACTION
 * ======================================================= */

function extractAnimation(
    instances
) {

    const sequences =
        instances.filter(
            instance =>
                instance.className ===
                "KeyframeSequence"
        );


    if (
        sequences.length === 0
    ) {

        return {
            found: false,

            keyframeSequence: null,

            keyframes: []
        };
    }


    const sequence =
        sequences[0];


    const keyframes =
        sequence.children
            .filter(
                child =>
                    child.className ===
                    "Keyframe"
            )
            .sort(
                (a, b) =>
                    getNumber(
                        a,
                        "Time"
                    ) -
                    getNumber(
                        b,
                        "Time"
                    )
            );


    return {
        found: true,

        keyframeSequence:
            sequence,

        keyframes:
            keyframes.map(
                extractKeyframe
            )
    };
}


/* =========================================================
 * KEYFRAME
 * ======================================================= */

function extractKeyframe(
    keyframe
) {

    return {
        referent:
            keyframe.referent,

        name:
            getProperty(
                keyframe,
                "Name",
                ""
            ),

        time:
            getNumber(
                keyframe,
                "Time"
            ),

        poses:
            keyframe.children
                .filter(
                    child =>
                        child.className ===
                        "Pose"
                )
                .map(
                    extractPose
                )
    };
}


/* =========================================================
 * POSE
 * ======================================================= */

function extractPose(
    pose
) {

    return {
        referent:
            pose.referent,

        name:
            getProperty(
                pose,
                "Name",
                ""
            ),

        cframe:
            getProperty(
                pose,
                "CFrame",
                null
            ),

        easingStyle:
            getProperty(
                pose,
                "EasingStyle",
                null
            ),

        easingDirection:
            getProperty(
                pose,
                "EasingDirection",
                null
            ),

        weight:
            getNumber(
                pose,
                "Weight",
                1
            ),

        maskWeight:
            getNumber(
                pose,
                "MaskWeight",
                1
            ),

        poses:
            pose.children
                .filter(
                    child =>
                        child.className ===
                        "Pose"
                )
                .map(
                    extractPose
                )
    };
}


/* =========================================================
 * PROPERTY HELPERS
 * ======================================================= */

function getProperty(
    instance,
    name,
    fallback
) {

    if (
        Object.prototype.hasOwnProperty.call(
            instance.properties,
            name
        )
    ) {

        return instance.properties[name];
    }


    return fallback;
}


function getNumber(
    instance,
    name,
    fallback = 0
) {

    const value =
        getProperty(
            instance,
            name,
            fallback
        );


    return typeof value === "number"
        ? value
        : fallback;
}


/* =========================================================
 * PROPERTY DECODING
 * ======================================================= */

function readPropertyValues(
    reader,
    typeId,
    count
) {

    switch (typeId) {

        case 0x01:
            return readStrings(
                reader,
                count
            );


        case 0x02:
            return readBools(
                reader,
                count
            );


        case 0x03:
            return readInterleavedInt32(
                reader,
                count,
                false
            );


        case 0x04:
            return readRobloxFloat32Array(
                reader,
                count
            );


        case 0x05:
            return readFloat64Array(
                reader,
                count
            );


        case 0x0b:
            return readInterleavedUint32(
                reader,
                count
            );


        case 0x0c:
            return readColor3Array(
                reader,
                count
            );


        case 0x0f:
            return readCFrameArray(
                reader,
                count
            );


        case 0x12:
            return readInterleavedUint32(
                reader,
                count
            );


        case 0x13:
            return readInterleavedInt32(
                reader,
                count,
                true
            );


        case 0x14:
            return readVector3Int16Array(
                reader,
                count
            );


        case 0x16:
            return readNumberRangeArray(
                reader,
                count
            );


        case 0x18:
            return readRectArray(
                reader,
                count
            );


        case 0x1a:
            return readColor3Uint8Array(
                reader,
                count
            );


        case 0x1c:
            return readSharedStringIndices(
                reader,
                count
            );


        case 0x1e:
            return readOptionalCFrameArray(
                reader,
                count
            );


        case 0x1f:
            return readUniqueIdArray(
                reader,
                count
            );


        case 0x20:
            return readFontArray(
                reader,
                count
            );


        case 0x22:
            return readContentArray(
                reader,
                count
            );


        default:

            throw new Error(
                `Unsupported RBXM property type 0x${typeId.toString(16)}.`
            );
    }
}


/* =========================================================
 * STRING
 * ======================================================= */

function readStringValue(
    reader
) {

    const length =
        reader.u32();

    return reader.string(
        length
    );
}


function readStrings(
    reader,
    count
) {

    const result = [];

    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push(
            readStringValue(
                reader
            )
        );
    }

    return result;
}


/* =========================================================
 * BOOL
 * ======================================================= */

function readBools(
    reader,
    count
) {

    const result = [];

    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push(
            reader.u8() !== 0
        );
    }

    return result;
}


/* =========================================================
 * INTEGER ARRAYS
 * ======================================================= */

function readInterleavedInt32(
    reader,
    count,
    accumulate
) {

    const bytes =
        reader.bytesArray(
            count * 4
        );


    const values =
        decodeInterleaved32(
            bytes,
            count
        );


    const result = [];


    let previous = 0;


    for (
        let i = 0;
        i < count;
        i++
    ) {

        const transformed =
            values[i];


        const value =
            untransformInt32(
                transformed
            );


        if (accumulate) {

            previous =
                (previous + value)
                | 0;

            result.push(
                previous
            );

        } else {

            result.push(
                value
            );
        }
    }


    return result;
}


function readInterleavedUint32(
    reader,
    count
) {

    const bytes =
        reader.bytesArray(
            count * 4
        );


    const values =
        decodeInterleaved32(
            bytes,
            count
        );


    return values.map(
        value =>
            value >>> 0
    );
}


function decodeInterleaved32(
    bytes,
    count
) {

    const result =
        new Array(count);


    for (
        let i = 0;
        i < count;
        i++
    ) {

        const b0 =
            bytes[i];


        const b1 =
            bytes[count + i];


        const b2 =
            bytes[count * 2 + i];


        const b3 =
            bytes[count * 3 + i];


        result[i] =
            (
                (b0 << 24) |
                (b1 << 16) |
                (b2 << 8) |
                b3
            );
    }


    return result;
}


function untransformInt32(
    value
) {

    return (
        value >>> 1
    ) ^
    -(
        value & 1
    );
}


/* =========================================================
 * FLOAT32
 * ======================================================= */

function readRobloxFloat32Array(
    reader,
    count
) {

    const bytes =
        reader.bytesArray(
            count * 4
        );


    const result =
        new Array(count);


    for (
        let i = 0;
        i < count;
        i++
    ) {

        const b0 =
            bytes[i];


        const b1 =
            bytes[count + i];


        const b2 =
            bytes[count * 2 + i];


        const b3 =
            bytes[count * 3 + i];


        const encoded =
            (
                (b0 << 24) |
                (b1 << 16) |
                (b2 << 8) |
                b3
            ) >>> 0;


        result[i] =
            decodeRobloxFloat(
                encoded
            );
    }


    return result;
}


function decodeRobloxFloat(
    bits
) {

    const sign =
        bits & 1;


    const exponent =
        (bits >>> 24) & 0xff;


    const mantissa =
        (bits >>> 1) & 0x7fffff;


    const standardBits =
        (
            (sign << 31) |
            (exponent << 23) |
            mantissa
        ) >>> 0;


    const buffer =
        new ArrayBuffer(4);


    const view =
        new DataView(buffer);


    view.setUint32(
        0,
        standardBits,
        false
    );


    return view.getFloat32(
        0,
        false
    );
}


/* =========================================================
 * FLOAT64
 * ======================================================= */

function readFloat64Array(
    reader,
    count
) {

    const result = [];

    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push(
            reader.f64()
        );
    }

    return result;
}


/* =========================================================
 * VECTOR3 INT16
 * ======================================================= */

function readVector3Int16Array(
    reader,
    count
) {

    const result = [];

    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push({
            x: reader.i16(),
            y: reader.i16(),
            z: reader.i16()
        });
    }

    return result;
}


/* =========================================================
 * COLOR3
 * ======================================================= */

function readColor3Array(
    reader,
    count
) {

    const r =
        readRobloxFloat32Array(
            reader,
            count
        );


    const g =
        readRobloxFloat32Array(
            reader,
            count
        );


    const b =
        readRobloxFloat32Array(
            reader,
            count
        );


    const result = [];


    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push({
            r: r[i],
            g: g[i],
            b: b[i]
        });
    }


    return result;
}


/* =========================================================
 * CFRAME
 * ======================================================= */

function readCFrameArray(
    reader,
    count
) {

    /*
     * CFrame:
     *
     * position: Vector3
     * rotation: compressed orientation matrix
     *
     * Roblox stores a CFrame using a special
     * rotation encoding.
     *
     * The animation converter needs the actual
     * position + rotation matrix.
     */

    const result = [];


    /*
     * Position is stored as three interleaved
     * Roblox float arrays.
     */

    const x =
        readRobloxFloat32Array(
            reader,
            count
        );


    const y =
        readRobloxFloat32Array(
            reader,
            count
        );


    const z =
        readRobloxFloat32Array(
            reader,
            count
        );


    /*
     * Rotation type is stored separately.
     *
     * The Roblox CFrame format uses a byte
     * orientation identifier followed by
     * orientation data.
     *
     * For animation conversion we preserve
     * the encoded rotation data.
     */

    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push({
            position: {
                x: x[i],
                y: y[i],
                z: z[i]
            },

            rotation: readCFrameRotation(
                reader
            )
        });
    }


    return result;
}


/*
 * CFrame rotation decoder.
 *
 * Roblox stores the rotation as a special
 * orientation code followed by the relevant
 * matrix values.
 */

function readCFrameRotation(
    reader
) {

    const code =
        reader.u8();


    /*
     * The most common CFrame representation
     * uses a compressed orientation code.
     *
     * We decode the common Roblox basis
     * orientations and preserve unknown
     * representations.
     */

    if (code <= 0x23) {

        const basis =
            cframeBasisFromCode(
                code
            );


        if (basis) {
            return basis;
        }
    }


    /*
     * Fallback: preserve the code.
     */

    return {
        type: "encoded",
        code
    };
}


/*
 * Roblox has a fixed table of orthogonal
 * orientations for the compressed CFrame form.
 */

function cframeBasisFromCode(
    code
) {

    /*
     * This table represents the 36 possible
     * axis-aligned orientations.
     *
     * Each matrix is:
     *
     * [ X.X X.Y X.Z
     *   Y.X Y.Y Y.Z
     *   Z.X Z.Y Z.Z ]
     */

    const table = [

        [1,0,0, 0,1,0, 0,0,1],
        [1,0,0, 0,0,-1, 0,1,0],
        [1,0,0, 0,-1,0, 0,0,-1],
        [1,0,0, 0,0,1, 0,-1,0],

        [-1,0,0, 0,1,0, 0,0,-1],
        [-1,0,0, 0,0,-1, 0,-1,0],
        [-1,0,0, 0,-1,0, 0,0,1],
        [-1,0,0, 0,0,1, 0,1,0],

        [0,1,0, 1,0,0, 0,0,-1],
        [0,1,0, 0,0,-1, -1,0,0],
        [0,1,0, -1,0,0, 0,0,1],
        [0,1,0, 0,0,1, 1,0,0],

        [0,-1,0, 1,0,0, 0,0,1],
        [0,-1,0, 0,0,-1, 1,0,0],
        [0,-1,0, -1,0,0, 0,0,-1],
        [0,-1,0, 0,0,1, -1,0,0],

        [0,0,1, 1,0,0, 0,1,0],
        [0,0,1, 0,1,0, -1,0,0],
        [0,0,1, -1,0,0, 0,-1,0],
        [0,0,1, 0,-1,0, 1,0,0],

        [0,0,-1, 1,0,0, 0,-1,0],
        [0,0,-1, 0,1,0, 1,0,0],
        [0,0,-1, -1,0,0, 0,1,0],
        [0,0,-1, 0,-1,0, -1,0,0]
    ];


    if (
        code < table.length
    ) {

        const m =
            table[code];


        return {
            type: "matrix",

            x: [m[0], m[1], m[2]],

            y: [m[3], m[4], m[5]],

            z: [m[6], m[7], m[8]]
        };
    }


    return null;
}


/* =========================================================
 * NUMBER RANGE
 * ======================================================= */

function readNumberRangeArray(
    reader,
    count
) {

    const result = [];

    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push({
            min: reader.f32(),
            max: reader.f32()
        });
    }

    return result;
}


/* =========================================================
 * RECT
 * ======================================================= */

function readRectArray(
    reader,
    count
) {

    const result = [];

    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push({
            min: {
                x: reader.f32(),
                y: reader.f32()
            },

            max: {
                x: reader.f32(),
                y: reader.f32()
            }
        });
    }

    return result;
}


/* =========================================================
 * COLOR3UINT8
 * ======================================================= */

function readColor3Uint8Array(
    reader,
    count
) {

    const r =
        reader.bytesArray(count);

    const g =
        reader.bytesArray(count);

    const b =
        reader.bytesArray(count);


    const result = [];


    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push({
            r: r[i],
            g: g[i],
            b: b[i]
        });
    }


    return result;
}


/* =========================================================
 * SHARED STRING
 * ======================================================= */

function readSharedStringIndices(
    reader,
    count
) {

    return readInterleavedUint32(
        reader,
        count
    );
}


/* =========================================================
 * OPTIONAL CFRAME
 * ======================================================= */

function readOptionalCFrameArray(
    reader,
    count
) {

    /*
     * OptionalCoordinateFrame begins with
     * the CFrame type identifier.
     */

    const type =
        reader.u8();


    if (type !== 0x0f) {

        throw new Error(
            "Invalid OptionalCoordinateFrame."
        );
    }


    const values =
        readCFrameArray(
            reader,
            count
        );


    const boolType =
        reader.u8();


    if (boolType !== 0x02) {

        throw new Error(
            "Invalid OptionalCoordinateFrame boolean array."
        );
    }


    const present =
        readBools(
            reader,
            count
        );


    return values.map(
        (value, i) =>
            present[i]
                ? value
                : null
    );
}


/* =========================================================
 * UNIQUE ID
 * ======================================================= */

function readUniqueIdArray(
    reader,
    count
) {

    const result = [];


    for (
        let i = 0;
        i < count;
        i++
    ) {

        const index =
            reader.u32();


        const time =
            reader.u32();


        const randomLow =
            reader.u32();


        const randomHigh =
            reader.i32();


        result.push({
            index,
            time,
            randomLow,
            randomHigh
        });
    }


    return result;
}


/* =========================================================
 * FONT
 * ======================================================= */

function readFontArray(
    reader,
    count
) {

    const result = [];


    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push({
            family:
                readStringValue(reader),

            cachedFaceId:
                readStringValue(reader),

            weight:
                reader.u16(),

            style:
                reader.u8()
        });
    }


    return result;
}


/* =========================================================
 * CONTENT
 * ======================================================= */

function readContentArray(
    reader,
    count
) {

    const result = [];


    for (
        let i = 0;
        i < count;
        i++
    ) {

        result.push(
            readStringValue(
                reader
            )
        );
    }


    return result;
}


/* =========================================================
 * GLOBAL EXPORT
 * ======================================================= */

if (
    typeof window !==
    "undefined"
) {

    window.parseRBXM =
        parseRBXM;

    window.parseRBXMBuffer =
        parseRBXMBuffer;
}