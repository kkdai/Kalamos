export interface DocumentSummary {
  id: string;
  path: string;
  revision: number;
  deleted: boolean;
  updatedAt: string;
}

export interface WorkspaceDocument extends DocumentSummary {
  content: string;
}

export interface AssetInput {
  path: string;
  mime: string;
  /** Base64 without a data URL prefix. */
  data: string;
}

export interface CreateDocumentInput {
  path: string;
  content: string;
  attachments?: AssetInput[];
}

export interface PatchDocumentInput {
  revision: number;
  content?: string;
  path?: string;
  deleted?: boolean;
}
