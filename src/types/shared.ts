export interface ApiIssue {
  path: string[];
  message: string;
}
export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: ApiIssue[];
  timestamp: string;
}
