/**
 * Proton Drive - Shared Types
 *
 * Common types and interfaces used across the application.
 */

// ============================================================================
// Node Types
// ============================================================================

export interface NodeData {
    name: string;
    uid: string;
    type: string;
}

export interface NodeResult {
    ok: boolean;
    value?: NodeData;
    error?: unknown;
}

export interface RootFolderResult {
    ok: boolean;
    value?: { uid: string };
    error?: unknown;
}

export interface CreateFolderResult {
    ok: boolean;
    value?: { uid: string };
    error?: unknown;
}

export interface DeleteResult {
    ok: boolean;
    error?: unknown;
}

// ============================================================================
// Upload Types
// ============================================================================

export interface UploadController {
    pause(): void;
    resume(): void;
    completion(): Promise<string>;
}

export interface FileUploader {
    getAvailableName(): Promise<string>;
    writeStream(
        stream: ReadableStream,
        thumbnails: [],
        onProgress?: (uploadedBytes: number) => void
    ): Promise<UploadController>;
}

export interface FileRevisionUploader {
    writeStream(
        stream: ReadableStream,
        thumbnails: [],
        onProgress?: (uploadedBytes: number) => void
    ): Promise<UploadController>;
}

export interface UploadMetadata {
    mediaType: string;
    expectedSize: number;
    modificationTime?: Date;
}

// ============================================================================
// Client Interfaces
// ============================================================================

/**
 * Base Proton Drive client interface with common operations
 */
export interface BaseProtonDriveClient {
    iterateFolderChildren(folderUid: string): AsyncIterable<NodeResult>;
    getMyFilesRootFolder(): Promise<RootFolderResult>;
}

/**
 * Proton Drive client interface for create operations
 */
export interface CreateProtonDriveClient extends BaseProtonDriveClient {
    createFolder(
        parentNodeUid: string,
        name: string,
        modificationTime?: Date
    ): Promise<CreateFolderResult>;
    getFileUploader(
        parentFolderUid: string,
        name: string,
        metadata: UploadMetadata,
        signal?: AbortSignal
    ): Promise<FileUploader>;
    getFileRevisionUploader(
        nodeUid: string,
        metadata: UploadMetadata,
        signal?: AbortSignal
    ): Promise<FileRevisionUploader>;
}

/**
 * Proton Drive client interface for delete operations
 */
export interface DeleteProtonDriveClient extends BaseProtonDriveClient {
    trashNodes(nodeUids: string[]): AsyncIterable<DeleteResult>;
    deleteNodes(nodeUids: string[]): AsyncIterable<DeleteResult>;
}

/**
 * Full Proton Drive client interface with all operations
 */
export interface ProtonDriveClient extends CreateProtonDriveClient, DeleteProtonDriveClient {}

// ============================================================================
// Operation Results
// ============================================================================

export interface CreateResult {
    success: boolean;
    nodeUid?: string;
    error?: string;
    isDirectory: boolean;
}

export interface DeleteOperationResult {
    success: boolean;
    existed: boolean;
    nodeUid?: string;
    nodeType?: string;
    error?: string;
}

// ============================================================================
// Path Types
// ============================================================================

export interface ParsedPath {
    parentParts: string[];
    name: string;
}

// ============================================================================
// Error Types
// ============================================================================

export interface ApiError extends Error {
    requires2FA?: boolean;
    code?: number;
}
