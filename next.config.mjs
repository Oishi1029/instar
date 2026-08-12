/** @type {import('next').NextConfig} */
export default {
  // `pg` is a native-ish Node module; keep it external to the server bundle.
  serverExternalPackages: ["pg", "@aws-sdk/client-bedrock-runtime"],
};
