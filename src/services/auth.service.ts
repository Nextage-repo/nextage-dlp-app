export class AuthService {
  async getTokenSilent(): Promise<string> {
    return "no-auth";
  }

  clearCache(): void {}
}

export const authService = new AuthService();
