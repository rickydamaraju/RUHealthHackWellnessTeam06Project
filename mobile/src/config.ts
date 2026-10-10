export const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'https://y2jsfmks3f.execute-api.us-east-1.amazonaws.com',
  cognitoDomain: process.env.EXPO_PUBLIC_COGNITO_DOMAIN ?? 'https://glucose-compass-506213937027-us-east-1-dev.auth.us-east-1.amazoncognito.com',
  clientId: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID ?? '21ov4cvd398djl34ce3nmqq7nr',
};
