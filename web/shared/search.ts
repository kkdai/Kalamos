export interface SearchHit {
  id: string;
  path: string;
  revision: number;
  /** Lines and UTF-16 columns are one-based; length is in UTF-16 units. */
  line: number;
  column: number;
  length: number;
  before: string;
  match: string;
  after: string;
}

export interface SearchResults {
  hits: SearchHit[];
  truncated: boolean;
}
