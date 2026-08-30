export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthSessionResponse {
  configured: boolean;
  user: AuthUser | null;
}

export interface AuthMutationResponse extends AuthSessionResponse {
  needsEmailConfirmation?: boolean;
  error?: string;
}
