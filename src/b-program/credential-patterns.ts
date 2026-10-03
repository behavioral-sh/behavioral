// AUTO-GENERATED — do not edit. Regenerate with `bun run betterleaks:generate`.
// Source: betterleaks v1.8.1 `config show` — the pinned binary's embedded ruleset.
// 411 provider rules. The broad generic-* rules and every detection-time
// Expr filter (entropy / token-efficiency) are intentionally excluded/dropped:
// redaction over-redacts rather than under-redacts.

/** A compiled provider credential rule (betterleaks-derived). */
export type CredentialRule = {
  id: string
  description: string
  pattern: RegExp
  keywords: string[]
}

export const CREDENTIAL_RULES: CredentialRule[] = [
  {
    id: '1password-secret-key',
    description: 'Uncovered a possible 1Password secret key, potentially compromising access to secrets in vaults.',
    pattern: /\bA3-[A-Z0-9]{6}-(?:(?:[A-Z0-9]{11})|(?:[A-Z0-9]{6}-[A-Z0-9]{5}))-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/g,
    keywords: ['a3-'],
  },
  {
    id: '1password-service-account-token',
    description:
      'Uncovered a possible 1Password service account token, potentially compromising access to secrets in vaults.',
    pattern: /ops_eyJ[a-zA-Z0-9+/]{250,}={0,3}/g,
    keywords: ['ops_eyj'],
  },
  {
    id: 'adafruit-api-key',
    description:
      'Identified a potential Adafruit API Key, which could lead to unauthorized access to Adafruit services and sensitive data exposure.',
    pattern:
      /(?:adafruit)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9_-]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['adafruit'],
  },
  {
    id: 'adobe-client-id',
    description:
      'Detected a pattern that resembles an Adobe OAuth Web Client ID, posing a risk of compromised Adobe integrations and data breaches.',
    pattern:
      /(?:adobe)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['adobe'],
  },
  {
    id: 'adobe-client-secret',
    description:
      'Discovered a potential Adobe Client Secret, which, if exposed, could allow unauthorized Adobe service access and data manipulation.',
    pattern: /\b(p8e-[a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['p8e-'],
  },
  {
    id: 'age-secret-key',
    description:
      'Discovered a potential Age encryption tool secret key, risking data decryption and unauthorized access to sensitive information.',
    pattern: /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/g,
    keywords: ['age-secret-key-1'],
  },
  {
    id: 'aikido-ci-token',
    description: 'Detected an Aikido CI token, which may allow unauthorized CI scan integration activity in Aikido.',
    pattern: /\b(AIK_CI_[A-Za-z0-9]{20,44})\b/g,
    keywords: ['aik_ci_'],
  },
  {
    id: 'aikido-client-id',
    description: 'Detected an Aikido client ID, used as a component of the aikido-client-secret composite rule.',
    pattern: /\b(AIK_CLIENT_[A-Za-z0-9]{24})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['aik_client_'],
  },
  {
    id: 'aikido-client-secret',
    description:
      'Detected an Aikido client secret, which may allow unauthorized access to Aikido APIs when paired with a client ID.',
    pattern: /\b(AIK_SECRET_[A-Za-z0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['aik_secret_'],
  },
  {
    id: 'airtable-api-key',
    description:
      'Uncovered a possible Airtable API Key, potentially compromising database access and leading to data leakage or alteration.',
    pattern:
      /(?:airtable)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{17})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['airtable'],
  },
  {
    id: 'airtable-oauth-token',
    description:
      'Detected an Airtable OAuth token, which may allow unauthorized access to Airtable resources granted to an OAuth integration.',
    pattern:
      /(?:airtable)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Z0-9]+\.v1\.[A-Z0-9_-]+\.[a-f0-9]+)(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['airtable'],
  },
  {
    id: 'aiven-auth-token',
    description: 'Detected an Aiven authentication token, which may expose Aiven projects and services.',
    pattern: /(?i:aiven)[\s\S]{0,32}?\b([A-Za-z0-9/+=]{372})(?:[^A-Za-z0-9/+=]|$)/g,
    keywords: ['aiven'],
  },
  {
    id: 'algolia-api-key',
    description:
      'Identified an Algolia API Key, which could result in unauthorized search operations and data exposure on Algolia-managed platforms.',
    pattern:
      /(?:algolia)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['algolia'],
  },
  {
    id: 'algolia-application-id',
    description: 'Detected an Algolia application ID, used as a component of the algolia-api-key composite rule.',
    pattern:
      /(?:algolia)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{10})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['algolia'],
  },
  {
    id: 'alibaba-access-key-id',
    description:
      'Detected an Alibaba Cloud AccessKey ID, posing a risk of unauthorized cloud resource access and potential data compromise.',
    pattern: /\b(LTAI[A-Za-z0-9]{17,21})\b/g,
    keywords: ['ltai'],
  },
  {
    id: 'alibaba-secret-key',
    description:
      'Discovered a potential Alibaba Cloud Secret Key, potentially allowing unauthorized operations and data access within Alibaba Cloud.',
    pattern:
      /(?:alibaba|aliyun|secret|key)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9]{30})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['alibaba', 'aliyun'],
  },
  {
    id: 'alibaba-sts-access-key-id',
    description:
      'Detected an Alibaba Cloud STS AccessKey ID, used as a component of the alibaba-sts-access-key-secret composite rule.',
    pattern: /\b(STS\.[A-Za-z0-9]{16,64})\b/g,
    keywords: ['sts.'],
  },
  {
    id: 'alibaba-sts-access-key-secret',
    description:
      'Detected an Alibaba Cloud STS AccessKey secret, which may allow temporary Alibaba Cloud API access when paired with an STS AccessKey ID and security token.',
    pattern:
      /(?:alibaba|aliyun|secret|key)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9]{30,64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['alibaba', 'aliyun'],
  },
  {
    id: 'alibaba-sts-security-token',
    description:
      'Detected an Alibaba Cloud STS security token, used as a component of the alibaba-sts-access-key-secret composite rule.',
    pattern:
      /(?:alibaba|aliyun|secret|key)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(CAIS[A-Za-z0-9+/_=-]{20,1000}[A-Za-z0-9+/_=-]{0,24})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['alibaba', 'aliyun', 'cais'],
  },
  {
    id: 'amplitude-secret-key',
    description:
      'Detected an Amplitude secret key, which may allow unauthorized event ingestion or access to Amplitude API functionality.',
    pattern:
      /\bamplitude(?:.|[\n\r]){0,32}?(?:SECRET|PRIVATE|ACCESS|KEY|TOKEN|AUTHORIZATION)(?:.|[\n\r]){0,16}?\b([a-f0-9]{32})\b/gi,
    keywords: ['amplitude'],
  },
  {
    id: 'anthropic-admin-api-key',
    description:
      'Detected an Anthropic Admin API Key, risking unauthorized access to administrative functions and sensitive AI model configurations.',
    pattern: /\b(sk-ant-admin01-[a-zA-Z0-9_-]{93}AA)(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sk-ant-admin01'],
  },
  {
    id: 'anthropic-api-key',
    description:
      'Identified an Anthropic API Key, which may compromise AI assistant integrations and expose sensitive data to unauthorized access.',
    pattern: /\b(sk-ant-api03-[a-zA-Z0-9_-]{93}AA)(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sk-ant-api03'],
  },
  {
    id: 'apify-api-token',
    description: 'Detected an Apify API token, which may expose actors, tasks, and stored data.',
    pattern: /\b(apify_api_[A-Za-z0-9]{34,38})\b/g,
    keywords: ['apify_api_'],
  },
  {
    id: 'artifactory-api-key',
    description: 'Detected an Artifactory api key, posing a risk unauthorized access to the central repository.',
    pattern: /\bAKCp[A-Za-z0-9]{68,70}\b/g,
    keywords: ['akcp'],
  },
  {
    id: 'artifactory-jfrog-url',
    description: 'Detected a JFrog Artifactory host, used as a component of Artifactory token validation.',
    pattern: /(?:^|[^a-z0-9-])([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.jfrog\.io)(?:$|[^a-z0-9-])/gi,
    keywords: ['jfrog.io'],
  },
  {
    id: 'artifactory-reference-token',
    description:
      'Detected an Artifactory reference token, posing a risk of impersonation and unauthorized access to the central repository.',
    pattern: /\bcmVmd[A-Za-z0-9]{59}\b/g,
    keywords: ['cmvmd'],
  },
  {
    id: 'asaas-api-token',
    description: 'Detected an Asaas API token, which may expose payment and customer data.',
    pattern: /(?:^|[^A-Za-z0-9_-])(\$aact_(?:prod|hmlg)_[A-Za-z0-9_-]{20,100})(?:[^A-Za-z0-9_-]|$)/g,
    keywords: ['$aact_'],
  },
  {
    id: 'asana-client-id',
    description:
      'Discovered a potential Asana Client ID, risking unauthorized access to Asana projects and sensitive task information.',
    pattern:
      /(?:asana)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['asana'],
  },
  {
    id: 'asana-client-secret',
    description:
      'Identified an Asana Client Secret, which could lead to compromised project management integrity and unauthorized access.',
    pattern:
      /(?:asana)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['asana'],
  },
  {
    id: 'assemblyai-api-key',
    description:
      'Detected an AssemblyAI API Key, which may expose speech-to-text services and associated audio data to unauthorized access.',
    pattern:
      /(?:assemblyai)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['assemblyai'],
  },
  {
    id: 'atlassian-api-token',
    description:
      'Detected an Atlassian API token, posing a threat to project management and collaboration tool security and data confidentiality.',
    pattern:
      /(?:(?-i:ATLASSIAN|[Aa]tlassian)|(?-i:CONFLUENCE|[Cc]onfluence)|(?-i:JIRA|[Jj]ira))(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{20}[a-f0-9]{4})(?:\\?['"\x60]|[\s;]|\\[nr]|$)|\b(ATATT3[A-Za-z0-9_\-=]{186})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['atlassian', 'confluence', 'jira', 'atatt3'],
  },
  {
    id: 'authress-service-client-access-key',
    description:
      'Uncovered a possible Authress Service Client Access Key, which may compromise access control services and sensitive data.',
    pattern:
      /\b((?:sc|ext|scauth|authress)_[a-z0-9]{5,30}\.[a-z0-9]{4,6}\.acc[_-][a-z0-9-]{10,32}\.[a-z0-9+/_=-]{30,120})\b/gi,
    keywords: ['.acc_', '.acc-'],
  },
  {
    id: 'aws-access-token',
    description:
      'Identified an AWS access key ID paired with a secret access key, which together can provide full access to AWS services.',
    pattern: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
    keywords: ['a3t', 'akia', 'asia', 'abia', 'acca'],
  },
  {
    id: 'aws-amazon-bedrock-api-key-long-lived',
    description:
      'Identified a pattern that may indicate long-lived Amazon Bedrock API keys, risking unauthorized Amazon Bedrock usage',
    pattern: /\b(ABSK[A-Za-z0-9+/]{109,269}={0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['absk'],
  },
  {
    id: 'aws-amazon-bedrock-api-key-short-lived',
    description:
      'Identified a pattern that may indicate short-lived Amazon Bedrock API keys, risking unauthorized Amazon Bedrock usage',
    pattern: /bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t/g,
    keywords: ['bedrock-api-key-'],
  },
  {
    id: 'aws-secret-access-key',
    description: 'Identified an AWS secret access key, used as a component of the aws-access-token composite rule.',
    pattern:
      /(?i:(?:secret|access|key|token)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9/+=]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['secret', 'access', 'key', 'token'],
  },
  {
    id: 'azure-ad-client-secret',
    description: 'Azure AD Client Secret',
    pattern: /(?:^|[\\'"\x60\s>=:(,)])([a-zA-Z0-9_~.]{3}\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\'"\x60\s<),])/g,
    keywords: ['0q~', '1q~', '2q~', '3q~', '4q~', '5q~', '6q~', '7q~', '8q~', '9q~'],
  },
  {
    id: 'azure-app-configuration-connection-string',
    description: 'Detected an Azure App Configuration connection string.',
    pattern:
      /Endpoint=(?<azure_appconfig_endpoint>https:\/\/[a-z0-9-]+\.azconfig\.io);Id=(?<azure_appconfig_id>[^;\s'"]{4,80});Secret=([A-Za-z0-9+/]{36,100}={0,2})/gi,
    keywords: ['azconfig.io', 'endpoint=', 'secret='],
  },
  {
    id: 'azure-client-id',
    description: 'Detected an Azure client ID, used as a component of Azure service principal validation.',
    pattern:
      /\b(?:client[_\s.-]*id|AZURE_CLIENT_ID)\b(?s:.{0,24}?)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi,
    keywords: ['client'],
  },
  {
    id: 'azure-servicebus-connection-string',
    description: 'Detected an Azure Service Bus or Event Hub shared access connection string.',
    pattern:
      /(Endpoint=sb:\/\/[a-z0-9-]+\.servicebus\.windows\.net\/;SharedAccessKeyName=[^;=\s'"]{1,128};SharedAccessKey=[A-Za-z0-9+/]{32,100}={0,2}(?:;EntityPath=[^;\s'"]{1,128})?)/gi,
    keywords: ['endpoint=sb://', 'sharedaccesskey'],
  },
  {
    id: 'azure-storage-account-key',
    description: 'Detected an Azure Storage account key.',
    pattern:
      /\b(?:AccountKey|(?:azure[_\s.-]*)?(?:storage[_\s.-]*)?(?:account[_\s.-]*)?(?:access[_\s.-]*)?key)\b(?s:.{0,24}?)([A-Za-z0-9+/]{86}==)/gi,
    keywords: ['accountkey', 'storage', 'key'],
  },
  {
    id: 'azure-storage-account-name',
    description: 'Detected an Azure Storage account name, used as a component of Azure Storage key validation.',
    pattern:
      /(?:\bAccountName\s*=\s*([a-z0-9]{3,24})\b|https:\/\/([a-z0-9]{3,24})\.blob\.core\.windows\.net\b|\b(?:azure[_\s.-]*storage[_\s.-]*(?:account[_\s.-]*)?name|storage[_\s.-]*account[_\s.-]*name)\b(?s:.{0,24}?)([a-z0-9]{3,24})\b)/gi,
    keywords: ['accountname', 'blob.core.windows.net', 'storage'],
  },
  {
    id: 'azure-tenant-id',
    description: 'Detected an Azure tenant ID, used as a component of Azure service principal validation.',
    pattern:
      /\b(?:tenant[_\s.-]*(?:id)?|AZURE_TENANT_ID)\b(?s:.{0,24}?)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi,
    keywords: ['tenant'],
  },
  {
    id: 'beamer-api-token',
    description:
      'Detected a Beamer API token, potentially compromising content management and exposing sensitive notifications and updates.',
    pattern:
      /(?:beamer)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(b_[a-z0-9=_-]{44})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['beamer'],
  },
  {
    id: 'bitbucket-client-id',
    description:
      'Discovered a potential Bitbucket Client ID, risking unauthorized repository access and potential codebase exposure.',
    pattern:
      /(?:bitbucket)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['bitbucket'],
  },
  {
    id: 'bitbucket-client-secret',
    description:
      'Discovered a potential Bitbucket Client Secret, posing a risk of compromised code repositories and unauthorized access.',
    pattern:
      /(?:bitbucket)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9=_-]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['bitbucket'],
  },
  {
    id: 'bitly-access-token',
    description:
      'Detected a Bitly access token, which may allow unauthorized access to Bitly account and link management APIs.',
    pattern: /\bbitly(?:.|[\n\r]){0,32}?(?:SECRET|PRIVATE|ACCESS|KEY|TOKEN)(?:.|[\n\r]){0,32}?([a-f0-9]{40})\b/gi,
    keywords: ['bitly'],
  },
  {
    id: 'bitrise-access-token',
    description:
      'Detected a Bitrise personal or workspace access token, which may expose CI/CD applications and builds.',
    pattern:
      /(?i:(?:bitrise(?:[ _-]*(?:personal|workspace))?(?:[ _-]*(?:access|api))?[ _-]*token)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9_-]{60,120})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['bitrise'],
  },
  {
    id: 'bittrex-access-key',
    description:
      'Identified a Bittrex Access Key, which could lead to unauthorized access to cryptocurrency trading accounts and financial loss.',
    pattern:
      /(?:bittrex)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['bittrex'],
  },
  {
    id: 'bittrex-secret-key',
    description:
      'Detected a Bittrex Secret Key, potentially compromising cryptocurrency transactions and financial security.',
    pattern:
      /(?:bittrex)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['bittrex'],
  },
  {
    id: 'box-api-access-token',
    description: 'Detected a Box API access token, which may expose Box files and account data.',
    pattern:
      /(?:box)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['box_', 'box-', 'boxt', 'boxk', 'boxa'],
  },
  {
    id: 'brave-search-api-key',
    description: 'Detected a Brave Search API key, which may allow unauthorized use of Brave Search API quota.',
    pattern: /\b(BSA[A-Za-z0-9_-]{24,40})\b/g,
    keywords: ['bsa'],
  },
  {
    id: 'buildkite-service-token',
    description: 'Detected a Buildkite agent, package, or portal token, which may expose CI/CD workloads or packages.',
    pattern:
      /\b(bkaa_[A-Za-z0-9_-]{75}|bkaj_[A-Za-z0-9_-]{333}|bkar_[A-Za-z0-9_-]{73}|bkct_[A-Za-z0-9_-]{73}|bkpt_[A-Za-z0-9_-]{199}|bkpat_[A-Za-z0-9_-]{54}|bkps_[A-Za-z0-9_-]{64})(?:$|[^A-Za-z0-9_-])/g,
    keywords: ['bkaa_', 'bkaj_', 'bkar_', 'bkct_', 'bkpt_', 'bkpat_', 'bkps_'],
  },
  {
    id: 'buildkite-user-access-token',
    description: 'Detected a Buildkite user access token, which may expose pipelines, builds, and organization data.',
    pattern: /\b(bkua_(?:[a-z0-9]{40}|[a-z0-9]{53}))\b/g,
    keywords: ['bkua_'],
  },
  {
    id: 'canadian-digital-service-notify-api-key',
    description: 'Detected a GC Notify API key, which may allow unauthorized notification access.',
    pattern:
      /(?i:\b(ApiKey-v1\s+gcntfy-[a-z0-9_]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b)/g,
    keywords: ['gcntfy-'],
  },
  {
    id: 'canva-client-id',
    description:
      'Detected a Canva Connect API client ID, used as a component of the canva-client-secret composite rule.',
    pattern:
      /\b(?:canva|CANVA_CLIENT_ID)(?:.|[\n\r]){0,32}?(?:client[_\s-]*id|app[_\s-]*id)(?:.|[\n\r]){0,16}?\b(OC-[A-Za-z0-9_-]{8,16})\b/gi,
    keywords: ['canva'],
  },
  {
    id: 'canva-client-secret',
    description:
      'Detected a Canva Connect API client secret, which may allow unauthorized OAuth client authentication when paired with a client ID.',
    pattern: /\b(cnvca[a-zA-Z0-9_-]{51})\b/g,
    keywords: ['cnvca'],
  },
  {
    id: 'cerebras-api-key',
    description: 'Identified a Cerebras AI API Key, which may expose AI inference services to unauthorized access.',
    pattern: /\b(csk-[a-z0-9]{48})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['csk-'],
  },
  {
    id: 'checkout-secret-key',
    description: 'Checkout.com secret key.',
    pattern:
      /(?:checkout)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sk_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['checkout'],
  },
  {
    id: 'circleci-personal-token',
    description: 'CircleCI personal access token.',
    pattern: /\b(CCIPAT_[a-zA-Z0-9]{22}_[a-z0-9]{40})/g,
    keywords: ['ccipat_'],
  },
  {
    id: 'circleci-project-token',
    description: 'CircleCI project token.',
    pattern:
      /(?:circleci)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['circleci'],
  },
  {
    id: 'cisco-meraki-api-key',
    description:
      'Cisco Meraki is a cloud-managed IT solution that provides networking, security, and device management through an easy-to-use interface.',
    pattern:
      /(?i:(?:(?-i:[Mm]eraki|MERAKI))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['meraki'],
  },
  {
    id: 'civo-api-key',
    description:
      'Detected a Civo Cloud API key, which may expose Kubernetes clusters and compute resources to unauthorized access.',
    pattern:
      /(?:civo)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{50})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['civo'],
  },
  {
    id: 'clerk-secret-key',
    description: 'Detected a Clerk secret key, which may allow unauthorized access to Clerk backend APIs.',
    pattern:
      /(?:clerk)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sk_(?:test|live)_[A-Za-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['clerk'],
  },
  {
    id: 'clickhouse-cloud-api-secret-key',
    description:
      'Identified a pattern that may indicate clickhouse cloud API secret key, risking unauthorized clickhouse cloud api access and data breaches on ClickHouse Cloud platforms.',
    pattern: /\b(4b1d[A-Za-z0-9]{38})\b/g,
    keywords: ['4b1d'],
  },
  {
    id: 'clickhouse-cloud-key-id',
    description:
      'Detected a ClickHouse Cloud key ID, used as a component of the clickhouse-cloud-api-secret-key composite rule.',
    pattern: /\bclickhouse(?:.|[\n\r]){0,16}?(?:ID|USER)(?:.|[\n\r]){0,16}?([a-z0-9]{20})/gi,
    keywords: ['clickhouse'],
  },
  {
    id: 'clickup-personal-api-token',
    description:
      'Detected a ClickUp personal API token, which may allow unauthorized access to ClickUp workspaces and user data.',
    pattern:
      /(?:clickup)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(pk_[0-9]{8,9}_[a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['clickup'],
  },
  {
    id: 'clojars-api-token',
    description:
      'Uncovered a possible Clojars API token, risking unauthorized access to Clojure libraries and potential code manipulation.',
    pattern: /CLOJARS_[a-z0-9]{60}/gi,
    keywords: ['clojars_'],
  },
  {
    id: 'cloudflare-api-key',
    description:
      'Detected a Cloudflare API Key, potentially compromising cloud application deployments and operational security.',
    pattern:
      /(?:cloudflare)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9_-]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['cloudflare'],
  },
  {
    id: 'cloudflare-global-api-key',
    description:
      'Detected a Cloudflare Global API Key, potentially compromising cloud application deployments and operational security.',
    pattern:
      /(?:cloudflare)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{37})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['cloudflare'],
  },
  {
    id: 'cloudflare-origin-ca-key',
    description:
      'Detected a Cloudflare Origin CA Key, potentially compromising cloud application deployments and operational security.',
    pattern: /\b(v1\.0-[a-f0-9]{24}-[a-f0-9]{146})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['cloudflare', 'v1.0-'],
  },
  {
    id: 'cloudinary-api-key',
    description: 'Detected a Cloudinary API key, used as a component of the cloudinary-api-secret composite rule.',
    pattern: /\bcloudinary(?:.|[\n\r]){0,32}?(?:API[_\s]?KEY|KEY)(?:.|[\n\r]){0,16}?\b([0-9]{15})\b/gi,
    keywords: ['cloudinary'],
  },
  {
    id: 'cloudinary-api-secret',
    description:
      'Detected a Cloudinary API secret, which may allow unauthorized access to Cloudinary media and account APIs when paired with a cloud name and API key.',
    pattern:
      /\bcloudinary(?:.|[\n\r]){0,32}?(?:SECRET|PRIVATE|API[_\s]?SECRET)(?:.|[\n\r]){0,32}?\b([A-Za-z0-9]{32})\b/gi,
    keywords: ['cloudinary'],
  },
  {
    id: 'cloudinary-cloud-name',
    description: 'Detected a Cloudinary cloud name, used as a component of the cloudinary-api-secret composite rule.',
    pattern: /\bcloudinary(?:.|[\n\r]){0,32}?(?:CLOUD[_\s]?NAME|CLOUD)(?:.|[\n\r]){0,16}?\b([a-z0-9_-]{3,32})\b/gi,
    keywords: ['cloudinary'],
  },
  {
    id: 'cloudsmith-api-key',
    description:
      'Detected a Cloudsmith API key, which may expose package repositories and artifact management operations to unauthorized access.',
    pattern: /\b(csa_[a-f0-9]{30}[A-Za-z0-9]{6})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['csa_'],
  },
  {
    id: 'cockroachlabs-cloud-api-key',
    description:
      'Detected a CockroachDB Cloud service account API key, which may allow unauthorized access to CockroachDB Cloud resources.',
    pattern: /\b(CCDB1_[A-Za-z0-9]{22}_[A-Za-z0-9]{40})\b/g,
    keywords: ['ccdb1_'],
  },
  {
    id: 'codecov-access-token',
    description:
      'Found a pattern resembling a Codecov Access Token, posing a risk of unauthorized access to code coverage reports and sensitive data.',
    pattern:
      /(?:codecov)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Z0-9-]{36})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['codecov'],
  },
  {
    id: 'cohere-api-token',
    description:
      'Identified a Cohere Token, posing a risk of unauthorized access to AI services and data manipulation.',
    pattern:
      /(?i:(?:cohere|CO_API_KEY)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-zA-Z0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['cohere', 'co_api_key'],
  },
  {
    id: 'coinbase-access-token',
    description:
      'Detected a Coinbase Access Token, posing a risk of unauthorized access to cryptocurrency accounts and financial transactions.',
    pattern:
      /(?:coinbase)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9_-]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['coinbase'],
  },
  {
    id: 'configcat-sdk-key',
    description: 'Detected a ConfigCat SDK key, which may allow access to feature flag configuration data.',
    pattern:
      /(?:configcat)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['configcat'],
  },
  {
    id: 'configcat-sdk-key-extended',
    description: 'Detected an extended ConfigCat SDK key, which may allow access to feature flag configuration data.',
    pattern: /\b(configcat-sdk-1\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['configcat-sdk-1'],
  },
  {
    id: 'confluent-access-token',
    description:
      'Identified a Confluent Access Token, which could compromise access to streaming data platforms and sensitive data flow.',
    pattern:
      /(?:confluent)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['confluent'],
  },
  {
    id: 'confluent-secret-key',
    description:
      'Found a Confluent Secret Key, potentially risking unauthorized operations and data access within Confluent services.',
    pattern:
      /(?:confluent)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['confluent'],
  },
  {
    id: 'contentful-delivery-api-token',
    description:
      'Discovered a Contentful delivery API token, posing a risk to content management systems and data integrity.',
    pattern:
      /(?:contentful)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9=_-]{43})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['contentful'],
  },
  {
    id: 'couchbase-capella-api-key',
    description:
      'Detected a Couchbase Capella API key secret, which may allow unauthorized access to Couchbase Capella management APIs.',
    pattern:
      /\b(?:couchbase|capella)(?:.|[\n\r]){0,32}?(?:api(?:.|[\n\r]){0,12}?(?:key|secret)|key(?:.|[\n\r]){0,12}?secret)(?:.|[\n\r]){0,32}?\b([A-Za-z0-9+/]{60,120}={0,2})\b/gi,
    keywords: ['couchbase', 'capella'],
  },
  {
    id: 'coveralls-personal-api-token',
    description: 'Detected a Coveralls personal API token, which may expose repository coverage data.',
    pattern:
      /(?:coveralls)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9-]{37})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['coveralls'],
  },
  {
    id: 'crates-io-api-key',
    description: 'crates.io API key.',
    pattern:
      /(?:crates(?:[_.-]?io)?)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(cio[A-Za-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['crates'],
  },
  {
    id: 'curl-auth-header',
    description:
      'Discovered a potential authorization token provided in a curl command header, which could compromise the curl accessed resource.',
    pattern:
      /\bcurl\b(?:.*?|.*?(?:[\r\n]{1,2}.*?){1,5})[ \t\n\r](?:-H|--header)(?:=|[ \t]{0,5})(?:"(?:Authorization:[ \t]{0,5}(?:Basic[ \t]([a-z0-9+/]{8,}={0,3})|(?:Bearer|(?:Api-)?Token)[ \t]([\w=~@.+/-]{8,})|([\w=~@.+/-]{8,}))|(?:(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)):[ \t]{0,5}([\w=~@.+/-]{8,}))"|'(?:Authorization:[ \t]{0,5}(?:Basic[ \t]([a-z0-9+/]{8,}={0,3})|(?:Bearer|(?:Api-)?Token)[ \t]([\w=~@.+/-]{8,})|([\w=~@.+/-]{8,}))|(?:(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)):[ \t]{0,5}([\w=~@.+/-]{8,}))')(?:\B|\s|$)/gi,
    keywords: ['curl'],
  },
  {
    id: 'curl-auth-user',
    description:
      'Discovered a potential basic authorization token provided in a curl command, which could compromise the curl accessed resource.',
    pattern:
      /\bcurl\b(?:.*|.*(?:[\r\n]{1,2}.*){1,5})[ \t\n\r](?:-u|--user)(?:=|[ \t]{0,5})("(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"|'([^:']{3,}:[^']{3,})'|((?:"[^"]{3,}"|'[^']{3,}'|[\w$@.-]+):(?:"[^"]{3,}"|'[^']{3,}'|[\w${}@.-]+)))(?:\s|$)/g,
    keywords: ['curl'],
  },
  {
    id: 'cursor-api-key',
    description:
      'Detected a Cursor Integrations API Key, which may expose AI-assisted development services to unauthorized access.',
    pattern:
      /(?:cursor)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(key_[0-9a-f]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['cursor'],
  },
  {
    id: 'databento-api-key',
    description: 'Databento API key.',
    pattern:
      /(?:databento)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(db-[A-Za-z0-9]{29})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['databento'],
  },
  {
    id: 'databricks-api-token',
    description:
      'Uncovered a Databricks API token, which may compromise big data analytics platforms and sensitive data processing.',
    pattern: /\b(dapi[a-f0-9]{32}(?:-\d)?)(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['dapi'],
  },
  {
    id: 'datadog-api-key',
    description:
      'Detected a Datadog API key, potentially risking monitoring and analytics data exposure and manipulation.',
    pattern:
      /(?:datadog)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['datadog'],
  },
  {
    id: 'datadog-application-key',
    description:
      'Detected a Datadog application key, which may expose Datadog account and monitoring data when paired with an API key.',
    pattern:
      /(?:datadog)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9-]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['datadog'],
  },
  {
    id: 'datagov-api-key',
    description: 'Detected a Data.gov API key, which may expose usage of Data.gov-backed APIs.',
    pattern:
      /(?:data\.gov)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['data.gov'],
  },
  {
    id: 'datastax-astra-application-token',
    description: 'DataStax Astra application token.',
    pattern: /\b(AstraCS:[A-Za-z0-9]{20,})/g,
    keywords: ['astracs:'],
  },
  {
    id: 'deepgram-api-key',
    description:
      'Detected a Deepgram API Key, which may expose speech recognition services and audio data to unauthorized access.',
    pattern:
      /(?:deepgram)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['deepgram'],
  },
  {
    id: 'deepseek-api-key',
    description:
      'Detected a DeepSeek API Key, which may expose AI model access and associated usage to unauthorized parties.',
    pattern:
      /(?:deepseek)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sk-[a-f0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['deepseek'],
  },
  {
    id: 'defined-networking-api-token',
    description:
      'Identified a Defined Networking API token, which could lead to unauthorized network operations and data breaches.',
    pattern:
      /(?:dnkey)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(dnkey-[a-z0-9=_-]{26}-[a-z0-9=_-]{52})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['dnkey'],
  },
  {
    id: 'deno-account-token',
    description: 'Detected a Deno account token, which may expose Deno Deploy account access.',
    pattern: /\b(ddp_[A-Za-z0-9]{36})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['ddp_'],
  },
  {
    id: 'devcycle-client-sdk-key',
    description: 'DevCycle client SDK key.',
    pattern: /\b(dvc_client_[A-Za-z0-9]{8,32})/g,
    keywords: ['dvc_client_'],
  },
  {
    id: 'devcycle-mobile-sdk-key',
    description: 'DevCycle mobile SDK key.',
    pattern: /\b(dvc_mobile_[A-Za-z0-9]{8,32})/g,
    keywords: ['dvc_mobile_'],
  },
  {
    id: 'devcycle-server-sdk-key',
    description: 'DevCycle server SDK key.',
    pattern: /\b(dvc_server_[A-Za-z0-9]{8,32})/g,
    keywords: ['dvc_server_'],
  },
  {
    id: 'devin-personal-api-key',
    description: 'Detected a Cognition Devin personal API key, which may expose Devin sessions and user data.',
    pattern: /\b(apk_user_[A-Za-z0-9+/]{120,180}={0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['apk_user_'],
  },
  {
    id: 'devin-service-api-key',
    description: 'Detected a Cognition Devin service API key, which may expose Devin sessions and organization access.',
    pattern: /\b(apk_[A-Za-z0-9+/]{80,100}={0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['apk_'],
  },
  {
    id: 'devin-service-user-token',
    description: 'Detected a Cognition Devin service user token, which may expose Devin service user access.',
    pattern: /\b(cog_[a-z2-7]{52})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['cog_'],
  },
  {
    id: 'digitalocean-access-token',
    description:
      'Found a DigitalOcean OAuth Access Token, risking unauthorized cloud resource access and data compromise.',
    pattern: /\b(doo_v1_[a-f0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['doo_v1_'],
  },
  {
    id: 'digitalocean-pat',
    description:
      'Discovered a DigitalOcean Personal Access Token, posing a threat to cloud infrastructure security and data privacy.',
    pattern: /\b(dop_v1_[a-f0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['dop_v1_'],
  },
  {
    id: 'digitalocean-refresh-token',
    description:
      'Uncovered a DigitalOcean OAuth Refresh Token, which could allow prolonged unauthorized access and resource manipulation.',
    pattern: /\b(dor_v1_[a-f0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['dor_v1_'],
  },
  {
    id: 'discord-api-token',
    description:
      'Detected a Discord API key, potentially compromising communication channels and user data privacy on Discord.',
    pattern:
      /(?:discord)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['discord'],
  },
  {
    id: 'discord-client-id',
    description:
      'Identified a Discord client ID, which may lead to unauthorized integrations and data exposure in Discord applications.',
    pattern:
      /(?:discord)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9]{18})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['discord'],
  },
  {
    id: 'discord-client-secret',
    description:
      'Discovered a potential Discord client secret, risking compromised Discord bot integrations and data leaks.',
    pattern:
      /(?:discord)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9=_-]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['discord'],
  },
  {
    id: 'disqus-api-key',
    description: 'Detected a Disqus API key, which may expose Disqus thread and account data.',
    pattern:
      /(?:disqus)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['disqus'],
  },
  {
    id: 'docker-swarm-join-token',
    description: 'Docker Swarm join token.',
    pattern: /\b(SWMTKN-1-[a-z0-9]{50,60}-[a-z0-9]{24,30})/g,
    keywords: ['swmtkn-1-'],
  },
  {
    id: 'docker-swarm-unlock-key',
    description: 'Docker Swarm unlock key.',
    pattern: /\b(SWMKEY-1-[A-Za-z0-9+/]{40,50})/g,
    keywords: ['swmkey-1-'],
  },
  {
    id: 'dockerhub-organization-access-token',
    description: 'Detected a Docker Hub organization access token, which may expose organization repositories.',
    pattern: /\b(dckr_oat_[A-Za-z0-9_-]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['dckr_oat_'],
  },
  {
    id: 'dockerhub-personal-access-token',
    description: 'Detected a Docker Hub personal access token, which may expose Docker Hub account access.',
    pattern: /\b(dckr_pat_[A-Za-z0-9_-]{27})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['dckr_pat_'],
  },
  {
    id: 'doppler-api-token',
    description: 'Discovered a Doppler API token, posing a risk to environment and secrets management security.',
    pattern: /dp\.pt\.[a-z0-9]{43}/gi,
    keywords: ['dp.pt.'],
  },
  {
    id: 'droneci-access-token',
    description:
      'Detected a Droneci Access Token, potentially compromising continuous integration and deployment workflows.',
    pattern:
      /(?:droneci)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['droneci'],
  },
  {
    id: 'dropbox-api-token',
    description:
      'Identified a Dropbox API secret, which could lead to unauthorized file access and data breaches in Dropbox storage.',
    pattern:
      /(?:dropbox)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{15})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['dropbox'],
  },
  {
    id: 'dropbox-long-lived-api-token',
    description:
      'Found a Dropbox long-lived API token, risking prolonged unauthorized access to cloud storage and sensitive data.',
    pattern:
      /(?:dropbox)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{11}(AAAAAAAAAA)[a-z0-9\-_=]{43})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['dropbox'],
  },
  {
    id: 'dropbox-short-lived-api-token',
    description:
      'Discovered a Dropbox short-lived API token, posing a risk of temporary but potentially harmful data access and manipulation.',
    pattern:
      /(?:dropbox)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sl\.[a-z0-9\-=_]{135})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['dropbox'],
  },
  {
    id: 'duffel-api-token',
    description:
      'Uncovered a Duffel API token, which may compromise travel platform integrations and sensitive customer data.',
    pattern: /duffel_(?:test|live)_[a-z0-9_\-=]{43}/gi,
    keywords: ['duffel_'],
  },
  {
    id: 'dynatrace-api-token',
    description:
      'Detected a Dynatrace API token, potentially risking application performance monitoring and data exposure.',
    pattern: /dt0c01\.[a-z0-9]{24}\.[a-z0-9]{64}/gi,
    keywords: ['dt0c01.'],
  },
  {
    id: 'easypost-api-token',
    description:
      'Identified an EasyPost API token, which could lead to unauthorized postal and shipment service access and data exposure.',
    pattern: /\bEZAK[a-z0-9]{54}\b/gi,
    keywords: ['ezak'],
  },
  {
    id: 'easypost-test-api-token',
    description:
      'Detected an EasyPost test API token, risking exposure of test environments and potentially sensitive shipment data.',
    pattern: /\bEZTK[a-z0-9]{54}\b/gi,
    keywords: ['eztk'],
  },
  {
    id: 'ebay-client-id',
    description: 'eBay client ID, used as a component of the eBay client-secret composite rule.',
    pattern: /\b([a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+-PRD-[a-f0-9]{8,12}-[a-f0-9]{8,12})/g,
    keywords: ['-prd-'],
  },
  {
    id: 'ebay-client-secret',
    description: 'eBay client secret.',
    pattern:
      /(?i:(?:ebay(?:[_. -]*(?:client|api))?[_. -]*(?:secret|key))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(PRD-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4,12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['ebay'],
  },
  {
    id: 'elastic-cloud-api-key',
    description:
      'Identified an Elastic Cloud Serverless API key, which may expose Elasticsearch and Kibana resources to unauthorized access.',
    pattern: /\b(essu_[A-Za-z0-9_-]{60,200}={0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['essu_'],
  },
  {
    id: 'elevenlabs-api-key',
    description: 'Detected an ElevenLabs API Key, which may expose AI voice synthesis services to unauthorized access.',
    pattern:
      /(?:elevenlabs)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sk_[0-9a-f]{48})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['elevenlabs'],
  },
  {
    id: 'endorlabs-api-key',
    description:
      'Detected an Endor Labs API Key, which may compromise supply chain security scanning and software composition analysis.',
    pattern:
      /(?:endor(?:labs)?|key)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(endr\+[A-Za-z0-9-]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['endr+'],
  },
  {
    id: 'endorlabs-api-secret',
    description:
      'Detected an Endor Labs API Secret, which together with an API key grants full access to Endor Labs supply chain security services.',
    pattern:
      /(?:endor(?:labs)?|secret)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(endr\+[A-Za-z0-9-]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['endr+'],
  },
  {
    id: 'etsy-open-api-key',
    description: 'Found an Etsy Open API key, potentially compromising Etsy app access and shop integrations.',
    pattern:
      /(?:etsy|x-api-key)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{24}:[a-z0-9]{10,64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['etsy', 'x-api-key'],
  },
  {
    id: 'exoscale-api-key',
    description:
      'Identified an Exoscale API key paired with a secret, which together grant programmatic access to Exoscale cloud resources.',
    pattern: /\b(EXO[a-zA-Z0-9]{24,30})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['exo'],
  },
  {
    id: 'exoscale-api-secret',
    description: 'Identified an Exoscale API secret, used as a component of the exoscale-api-key composite rule.',
    pattern:
      /(?:exoscale)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9_-]{40,60})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['exoscale'],
  },
  {
    id: 'facebook-access-token',
    description:
      'Discovered a Facebook Access Token, posing a risk of unauthorized access to Facebook accounts and personal data exposure.',
    pattern: /\b(\d{15,16}(\||%)[0-9a-z\-_]{27,40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['facebook'],
  },
  {
    id: 'facebook-page-access-token',
    description:
      'Discovered a Facebook Page Access Token, posing a risk of unauthorized access to Facebook accounts and personal data exposure.',
    pattern: /\b(EAA[MC][a-z0-9]{100,})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['eaam', 'eaac'],
  },
  {
    id: 'facebook-secret',
    description:
      'Discovered a Facebook Application secret, posing a risk of unauthorized access to Facebook accounts and personal data exposure.',
    pattern:
      /(?:facebook)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['facebook'],
  },
  {
    id: 'fastly-api-token',
    description:
      'Uncovered a Fastly API key, which may compromise CDN and edge cloud services, leading to content delivery and security issues.',
    pattern:
      /(?:fastly)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9_-]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['fastly'],
  },
  {
    id: 'figma-personal-access-header-token',
    description:
      'Uncovered a Figma Personal Access Token in a header, which may compromise design assets and team collaboration.',
    pattern:
      /(?:x-figma-token|xfigmatoken|x_figma_token)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9A-F]{4}-[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['x-figma-token', 'xfigmatoken', 'x_figma_token'],
  },
  {
    id: 'figma-personal-access-token',
    description: 'Uncovered a Figma Personal Access Token, which may compromise design assets and team collaboration.',
    pattern: /\b(figd_[A-Z0-9_-]{38,42})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['figd_'],
  },
  {
    id: 'finicity-api-token',
    description:
      'Detected a Finicity API token, potentially risking financial data access and unauthorized financial operations.',
    pattern:
      /(?:finicity)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['finicity'],
  },
  {
    id: 'finicity-client-secret',
    description:
      'Identified a Finicity Client Secret, which could lead to compromised financial service integrations and data breaches.',
    pattern:
      /(?:finicity)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{20})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['finicity'],
  },
  {
    id: 'finnhub-access-token',
    description: 'Found a Finnhub Access Token, risking unauthorized access to financial market data and analytics.',
    pattern:
      /(?:finnhub)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{20})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['finnhub'],
  },
  {
    id: 'flickr-access-token',
    description:
      'Discovered a Flickr Access Token, posing a risk of unauthorized photo management and potential data leakage.',
    pattern:
      /(?:flickr)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['flickr'],
  },
  {
    id: 'flutterwave-encryption-key',
    description:
      'Uncovered a Flutterwave Encryption Key, which may compromise payment processing and sensitive financial information.',
    pattern: /FLWSECK_TEST-[a-h0-9]{12}/gi,
    keywords: ['flwseck_test'],
  },
  {
    id: 'flutterwave-public-key',
    description:
      'Detected a Flutterwave Public Key, potentially exposing public cryptographic operations and integrations.',
    pattern: /FLWPUBK_TEST-[a-h0-9]{32}-X/gi,
    keywords: ['flwpubk_test'],
  },
  {
    id: 'flutterwave-secret-key',
    description: 'Identified a Flutterwave Secret Key, risking unauthorized financial transactions and data breaches.',
    pattern: /FLWSECK_TEST-[a-h0-9]{32}-X/gi,
    keywords: ['flwseck_test'],
  },
  {
    id: 'flyio-access-token',
    description: 'Uncovered a Fly.io API key',
    pattern: /\b(FlyV1\s[A-Za-z0-9=_\-,/+]{100,})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['flyv1'],
  },
  {
    id: 'frameio-api-token',
    description: 'Found a Frame.io API token, potentially compromising video collaboration and project management.',
    pattern: /fio-u-[a-z0-9\-_=]{64}/gi,
    keywords: ['fio-u-'],
  },
  {
    id: 'freemius-secret-key',
    description: 'Detected a Freemius secret key, potentially exposing sensitive information.',
    pattern: /["']secret_key["']\s*=>\s*["'](sk_[\S]{29})["']/gi,
    keywords: ['secret_key'],
  },
  {
    id: 'freshbooks-access-token',
    description:
      'Discovered a Freshbooks Access Token, posing a risk to accounting software access and sensitive financial data exposure.',
    pattern:
      /(?:freshbooks)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['freshbooks'],
  },
  {
    id: 'fullstory-api-key',
    description: 'FullStory API key.',
    pattern:
      /(?:(?:fullstory|fs_api|fullstory_api))(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}((?:na1|eu1)\.[A-Za-z0-9]{20,})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['fullstory', 'fs_api'],
  },
  {
    id: 'gcp-api-key',
    description:
      'Uncovered a GCP API key, which could lead to unauthorized access to Google Cloud services and data breaches.',
    pattern: /\b(AIza[\w-]{35})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['aiza'],
  },
  {
    id: 'gcp-application-default-credentials',
    description: 'Google (GCP) Application Default Credentials',
    pattern:
      /\{[^{]+(?:(?:"client_secret"\s*:\s*"[^"]+"[^}]+"refresh_token"\s*:\s*"[^"]+")|(?:"refresh_token"\s*:\s*"[^"]+"[^}]+"client_secret"\s*:\s*"[^"]+"))[^}]+\}/g,
    keywords: ['.apps.googleusercontent.com'],
  },
  {
    id: 'gcp-gemini-api',
    description:
      'Detected a Google Gemini API key, which may expose Gemini model access and usage to unauthorized parties.',
    pattern: /\b(AQ\.Ab8RN6[A-Za-z0-9_-]{44})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['aq.ab8rn6'],
  },
  {
    id: 'gcp-service-account',
    description: 'Google (GCP) Service-account',
    pattern:
      /\{[^{]+(?:(?:"private_key"\s*:\s*"-----BEGIN (?:RSA )?PRIVATE KEY-----[^}]+auth_provider_x509_cert_url)|(?:auth_provider_x509_cert_url[^}]+"private_key"\s*:\s*"-----BEGIN (?:RSA )?PRIVATE KEY-----))[^}]+\}/g,
    keywords: ['provider_x509'],
  },
  {
    id: 'gitea-access-token',
    description:
      'Detected a Gitea Access Token, which may expose self-hosted Git repositories and associated code to unauthorized access.',
    pattern:
      /(?:gitea[_.-]?(?:token|key|secret|access))(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['gitea'],
  },
  {
    id: 'github-app-token',
    description:
      'Identified a GitHub App Token, which may compromise GitHub application integrations and source code security.',
    pattern: /(?:ghu|ghs)_[0-9a-zA-Z]{36}/g,
    keywords: ['ghu_', 'ghs_'],
  },
  {
    id: 'github-fine-grained-pat',
    description:
      'Found a GitHub Fine-Grained Personal Access Token, risking unauthorized repository access and code manipulation.',
    pattern: /github_pat_\w{82}/g,
    keywords: ['github_pat_'],
  },
  {
    id: 'github-oauth',
    description:
      'Discovered a GitHub OAuth Access Token, posing a risk of compromised GitHub account integrations and data leaks.',
    pattern: /gho_[0-9a-zA-Z]{36}/g,
    keywords: ['gho_'],
  },
  {
    id: 'github-pat',
    description:
      'Uncovered a GitHub Personal Access Token, potentially leading to unauthorized repository access and sensitive content exposure.',
    pattern: /ghp_[0-9a-zA-Z]{36}/g,
    keywords: ['ghp_'],
  },
  {
    id: 'github-refresh-token',
    description: 'Detected a GitHub Refresh Token, which could allow prolonged unauthorized access to GitHub services.',
    pattern: /ghr_[0-9a-zA-Z]{36}/g,
    keywords: ['ghr_'],
  },
  {
    id: 'gitlab-cicd-job-token',
    description:
      'Identified a GitLab CI/CD Job Token, potential access to projects and some APIs on behalf of a user while the CI job is running.',
    pattern: /glcbt-[0-9a-zA-Z]{1,5}_[0-9a-zA-Z_-]{20}/g,
    keywords: ['glcbt-'],
  },
  {
    id: 'gitlab-deploy-token',
    description:
      'Identified a GitLab Deploy Token, risking access to repositories, packages and containers with write access.',
    pattern: /gldt-[0-9a-zA-Z_-]{20}/g,
    keywords: ['gldt-'],
  },
  {
    id: 'gitlab-feature-flag-client-token',
    description:
      'Identified a GitLab feature flag client token, risks exposing user lists and features flags used by an application.',
    pattern: /glffct-[0-9a-zA-Z_-]{20}/g,
    keywords: ['glffct-'],
  },
  {
    id: 'gitlab-feed-token',
    description: 'Identified a GitLab feed token, risking exposure of user data.',
    pattern: /glft-[0-9a-zA-Z_-]{20}/g,
    keywords: ['glft-'],
  },
  {
    id: 'gitlab-incoming-mail-address-token',
    description:
      'Identified a GitLab incoming mail token embedded in an email address, risking manipulation of data sent by mail.',
    pattern: /incoming\+(?:[A-Za-z0-9._-]+-)?\d+-([A-Za-z0-9_-]+)-(?:issue(?:-\d+)?|merge-request)@/g,
    keywords: ['incoming+'],
  },
  {
    id: 'gitlab-incoming-mail-token',
    description: 'Identified a GitLab incoming mail token, risking manipulation of data sent by mail.',
    pattern: /glimt-[0-9a-zA-Z_-]{25}/g,
    keywords: ['glimt-'],
  },
  {
    id: 'gitlab-kubernetes-agent-token',
    description:
      'Identified a GitLab Kubernetes Agent token, risking access to repos and registry of projects connected via agent.',
    pattern: /glagent-[0-9a-zA-Z_-]{50}/g,
    keywords: ['glagent-'],
  },
  {
    id: 'gitlab-oauth-app-secret',
    description:
      'Identified a GitLab OIDC Application Secret, risking access to apps using GitLab as authentication provider.',
    pattern: /gloas-[0-9a-zA-Z_-]{64}/g,
    keywords: ['gloas-'],
  },
  {
    id: 'gitlab-pat',
    description:
      'Identified a GitLab Personal Access Token, risking unauthorized access to GitLab repositories and codebase exposure.',
    pattern: /glpat-[\w-]{20}/g,
    keywords: ['glpat-'],
  },
  {
    id: 'gitlab-pat-routable',
    description:
      'Identified a GitLab Personal Access Token (routable), risking unauthorized access to GitLab repositories and codebase exposure.',
    pattern: /\bglpat-[0-9a-zA-Z_-]{27,300}\.[0-9a-z]{2}[0-9a-z]{7}\b/g,
    keywords: ['glpat-'],
  },
  {
    id: 'gitlab-pat-routable-versioned',
    description:
      'Identified a GitLab Personal Access Token (routable, versioned), risking unauthorized access to GitLab repositories and codebase exposure.',
    pattern: /\bglpat-[0-9a-zA-Z_-]{27,300}\.[0-9a-z]{2}\.[0-9a-z]{9}\b/g,
    keywords: ['glpat-'],
  },
  {
    id: 'gitlab-ptt',
    description:
      'Found a GitLab Pipeline Trigger Token, potentially compromising continuous integration workflows and project security.',
    pattern: /glptt-[0-9a-f]{40}/g,
    keywords: ['glptt-'],
  },
  {
    id: 'gitlab-rrt',
    description:
      'Discovered a GitLab Runner Registration Token, posing a risk to CI/CD pipeline integrity and unauthorized access.',
    pattern: /GR1348941[\w-]{20}/g,
    keywords: ['gr1348941'],
  },
  {
    id: 'gitlab-runner-authentication-token',
    description:
      'Discovered a GitLab Runner Authentication Token, posing a risk to CI/CD pipeline integrity and unauthorized access.',
    pattern: /glrt-[0-9a-zA-Z_-]{20}/g,
    keywords: ['glrt-'],
  },
  {
    id: 'gitlab-runner-authentication-token-routable',
    description:
      'Discovered a GitLab Runner Authentication Token (Routable), posing a risk to CI/CD pipeline integrity and unauthorized access.',
    pattern: /\bglrt-t\d_[0-9a-zA-Z_-]{27,300}\.[0-9a-z]{2}[0-9a-z]{7}\b/g,
    keywords: ['glrt-'],
  },
  {
    id: 'gitlab-scim-token',
    description: 'Discovered a GitLab SCIM Token, posing a risk to unauthorized access for a organization or instance.',
    pattern: /glsoat-[0-9a-zA-Z_-]{20}/g,
    keywords: ['glsoat-'],
  },
  {
    id: 'gitlab-session-cookie',
    description: 'Discovered a GitLab Session Cookie, posing a risk to unauthorized access to a user account.',
    pattern: /_gitlab_session=[0-9a-z]{32}/g,
    keywords: ['_gitlab_session='],
  },
  {
    id: 'gitter-access-token',
    description:
      'Uncovered a Gitter Access Token, which may lead to unauthorized access to chat and communication services.',
    pattern:
      /(?:gitter)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9_-]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['gitter'],
  },
  {
    id: 'gocardless-api-token',
    description:
      'Detected a GoCardless API token, potentially risking unauthorized direct debit payment operations and financial data exposure.',
    pattern:
      /(?:gocardless)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(live_[a-z0-9\-_=]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['live_', 'gocardless'],
  },
  {
    id: 'grafana-api-key',
    description:
      'Identified a Grafana API key, which could compromise monitoring dashboards and sensitive data analytics.',
    pattern: /\b(eyJrIjoi[A-Za-z0-9+/]{40,380}={0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['eyjrijoi'],
  },
  {
    id: 'grafana-cloud-api-token',
    description:
      'Found a Grafana cloud API token, risking unauthorized access to cloud-based monitoring services and data exposure.',
    pattern: /\b(glc_[A-Za-z0-9+/]{40,150}={0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['glc_'],
  },
  {
    id: 'grafana-service-account-token',
    description:
      'Discovered a Grafana service account token, posing a risk of compromised monitoring services and data integrity.',
    pattern: /\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['glsa_'],
  },
  {
    id: 'greptile-api-key',
    description:
      'Detected a Greptile API Key, which may expose AI-powered code search and analysis services to unauthorized access.',
    pattern:
      /(?:greptile)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-zA-Z0-9+/]{48})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['greptile'],
  },
  {
    id: 'groq-api-key',
    description: 'Identified a Groq API Key, which may expose high-speed AI inference services to unauthorized access.',
    pattern: /\b(gsk_[A-Z0-9]{52})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['gsk_'],
  },
  {
    id: 'gumroad-access-token',
    description: 'Detected a Gumroad access token, which may expose Gumroad account and product data.',
    pattern:
      /(?:gumroad)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}((?:[a-f0-9]{64}|[A-Za-z0-9-]{43}))(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['gumroad'],
  },
  {
    id: 'harness-api-key',
    description: 'Identified a Harness Access Token (PAT or SAT), risking unauthorized access to a Harness account.',
    pattern: /(?:pat|sat)\.[a-zA-Z0-9_-]{22}\.[0-9a-f]{24}\.[a-zA-Z0-9]{20}/g,
    keywords: ['pat.', 'sat.'],
  },
  {
    id: 'hashicorp-tf-api-token',
    description:
      'Uncovered a HashiCorp Terraform user/org API token, which may lead to unauthorized infrastructure management and security breaches.',
    pattern: /[a-z0-9]{14}\.(?-i:atlasv1)\.[a-z0-9\-_=]{60,70}/gi,
    keywords: ['atlasv1'],
  },
  {
    id: 'hashicorp-tf-password',
    description:
      'Identified a HashiCorp Terraform password field, risking unauthorized infrastructure configuration and security breaches.',
    pattern:
      /(?:administrator_login_password|password)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}("[a-z0-9=_-]{8,20}")(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['administrator_login_password', 'password'],
  },
  {
    id: 'heroku-api-key',
    description:
      'Detected a Heroku API Key, potentially compromising cloud application deployments and operational security.',
    pattern:
      /(?:heroku)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['heroku'],
  },
  {
    id: 'heroku-api-key-v2',
    description:
      'Detected a Heroku API Key, potentially compromising cloud application deployments and operational security.',
    pattern: /\b((HRKU-AA[0-9a-zA-Z_-]{58}))(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['hrku-aa'],
  },
  {
    id: 'highnote-secret-live-key',
    description: 'Highnote secret API key for the live environment.',
    pattern:
      /(?i:(?:highnote(?:[_. -]*(?:api))?[_. -]*(?:secret|key|token|sk[_. -]*live))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sk_live_a2V5Xz[A-Za-z0-9+/]{69}={0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['highnote'],
  },
  {
    id: 'honeycomb-api-key',
    description: 'Detected a Honeycomb API key, which may expose Honeycomb telemetry and environment data.',
    pattern:
      /(?:honeycomb)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}((?:[a-f0-9]{32}|[a-z0-9]{22}))(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['honeycomb'],
  },
  {
    id: 'hubspot-api-key',
    description:
      'Found a HubSpot API Token, posing a risk to CRM data integrity and unauthorized marketing operations.',
    pattern:
      /(?:hubspot)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['hubspot'],
  },
  {
    id: 'huggingface-access-token',
    description:
      'Discovered a Hugging Face Access token, which could lead to unauthorized access to AI models and sensitive data.',
    pattern: /\b(hf_(?i:[a-z]{34}))(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['hf_'],
  },
  {
    id: 'huggingface-organization-api-token',
    description:
      'Uncovered a Hugging Face Organization API token, potentially compromising AI organization accounts and associated data.',
    pattern: /\b(api_org_(?i:[a-z]{34}))(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['api_org_'],
  },
  {
    id: 'ibm-cloud-user-api-key',
    description: 'Detected an IBM Cloud user API key, which may expose IBM Cloud account resources.',
    pattern:
      /(?:ibm(?:cloud)?|bx)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9_-]{42,44})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['ibm'],
  },
  {
    id: 'influxdb-api-token',
    description:
      'Detected an InfluxDB API token, which may allow unauthorized access to time-series data and InfluxDB organization resources.',
    pattern:
      /(?:\binflux(?:db)?\b(?:.|[\n\r]){0,64}?\b(?:token|api[_-]?key)\b(?:.|[\n\r]){0,32}?)[=:"'\s]{1,8}([A-Za-z0-9+/=_-]{88,})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['influx'],
  },
  {
    id: 'infomaniak-api-token',
    description:
      'Detected an Infomaniak API token, which may expose hosting, mail, and cloud services to unauthorized access.',
    pattern:
      /(?:infomaniak)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9_-]{60,100})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['infomaniak'],
  },
  {
    id: 'infracost-api-token',
    description:
      'Detected an Infracost API Token, risking unauthorized access to cloud cost estimation tools and financial data.',
    pattern: /\b(ico-[a-zA-Z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['ico-'],
  },
  {
    id: 'intercom-api-key',
    description:
      'Identified an Intercom API Token, which could compromise customer communication channels and data privacy.',
    pattern:
      /(?:intercom)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9=_-]{60})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['intercom'],
  },
  {
    id: 'intra42-client-secret',
    description:
      'Found a Intra42 client secret, which could lead to unauthorized access to the 42School API and sensitive data.',
    pattern: /\b(s-s4t2(?:ud|af)-[abcdef0123456789]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['intra', 's-s4t2ud-', 's-s4t2af-'],
  },
  {
    id: 'ionic-personal-access-token',
    description: 'Ionic personal access token.',
    pattern: /\b(ion_[A-Za-z0-9]{42})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['ion_'],
  },
  {
    id: 'jumpcloud-api-key',
    description: 'Detected a JumpCloud API key, which may expose JumpCloud directory data.',
    pattern:
      /(?:jumpcloud)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['jumpcloud'],
  },
  {
    id: 'jwt',
    description:
      'Uncovered a JSON Web Token, which may lead to unauthorized access to web applications and sensitive user data.',
    pattern:
      /\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9\\/\\_-]{17,}\.(?:[a-zA-Z0-9\\/\\_-]{10,}={0,2})?)(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['eyj'],
  },
  {
    id: 'jwt-base64',
    description:
      'Detected a Base64-encoded JSON Web Token, posing a risk of exposing encoded authentication and data exchange information.',
    pattern:
      /\bZXlK(?:(?<alg>aGJHY2lPaU)|(?<apu>aGNIVWlPaU)|(?<apv>aGNIWWlPaU)|(?<aud>aGRXUWlPaU)|(?<b64>aU5qUWlP)|(?<crit>amNtbDBJanBi)|(?<cty>amRIa2lPaU)|(?<epk>bGNHc2lPbn)|(?<enc>bGJtTWlPaU)|(?<jku>cWEzVWlPaU)|(?<jwk>cWQyc2lPb)|(?<iss>cGMzTWlPaU)|(?<iv>cGRpSTZJ)|(?<kid>cmFXUWlP)|(?<key_ops>clpYbGZiM0J6SWpwY)|(?<kty>cmRIa2lPaUp)|(?<nonce>dWIyNWpaU0k2)|(?<p2c>d01tTWlP)|(?<p2s>d01uTWlPaU)|(?<ppt>d2NIUWlPaU)|(?<sub>emRXSWlPaU)|(?<svt>emRuUWlP)|(?<tag>MFlXY2lPaU)|(?<typ>MGVYQWlPaUp)|(?<url>MWNtd2l)|(?<use>MWMyVWlPaUp)|(?<ver>MlpYSWlPaU)|(?<version>MlpYSnphVzl1SWpv)|(?<x>NElqb2)|(?<x5c>NE5XTWlP)|(?<x5t>NE5YUWlPaU)|(?<x5ts256>NE5YUWpVekkxTmlJNkl)|(?<x5u>NE5YVWlPaU)|(?<zip>NmFYQWlPaU))[a-zA-Z0-9\\/\\_+\-\r\n]{40,}={0,2}/g,
    keywords: ['zxlk'],
  },
  {
    id: 'kagi-api-key',
    description: 'Detected a Kagi API key, which may expose Kagi API usage.',
    pattern:
      /(?:kagi)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9_-]{11}\.[a-z0-9_-]{43})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['kagi'],
  },
  {
    id: 'kimi-api-key',
    description:
      'Detected a Kimi API key, which may expose Moonshot AI model access and usage to unauthorized parties.',
    pattern:
      /(?:kimi|moonshot)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sk-[A-Za-z0-9_-]{48})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['kimi', 'moonshot'],
  },
  {
    id: 'klaviyo-api-key',
    description: 'Detected a Klaviyo API key, which may expose Klaviyo account and marketing data.',
    pattern:
      /(?:klaviyo)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(pk_[a-z0-9]{34})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['klaviyo'],
  },
  {
    id: 'kraken-access-token',
    description:
      'Identified a Kraken Access Token, potentially compromising cryptocurrency trading accounts and financial security.',
    pattern:
      /(?:kraken)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9\\/=_+-]{80,90})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['kraken'],
  },
  {
    id: 'kubernetes-secret-yaml',
    description:
      'Possible Kubernetes Secret detected, posing a risk of leaking credentials/tokens from your deployments',
    pattern:
      /(?:\bkind:[ \t]*["']?\bsecret\b["']?(?s:.){0,1000}?\bdata:(?s:.){0,100}?\s+([\w.-]+:(?:[ \t]*(?:\||>[-+]?)\s+)?[ \t]*(?:["']?[a-z0-9+/]{10,}={0,3}["']?|\{\{[ \t\w"|$:=,.-]+}}|""|''))|\bdata:(?s:.){0,100}?\s+([\w.-]+:(?:[ \t]*(?:\||>[-+]?)\s+)?[ \t]*(?:["']?[a-z0-9+/]{10,}={0,3}["']?|\{\{[ \t\w"|$:=,.-]+}}|""|''))(?s:.){0,1000}?\bkind:[ \t]*["']?\bsecret\b["']?)/gi,
    keywords: ['secret'],
  },
  {
    id: 'kucoin-access-token',
    description:
      'Found a Kucoin Access Token, risking unauthorized access to cryptocurrency exchange services and transactions.',
    pattern:
      /(?:kucoin)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{24})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['kucoin'],
  },
  {
    id: 'kucoin-secret-key',
    description:
      'Discovered a Kucoin Secret Key, which could lead to compromised cryptocurrency operations and financial data breaches.',
    pattern:
      /(?:kucoin)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['kucoin'],
  },
  {
    id: 'langchain-langsmith-personal-access-token',
    description: 'LangSmith personal access token.',
    pattern: /\b(lsv2_pt_[0-9a-fA-F]{32}_[0-9a-fA-F]{10})/g,
    keywords: ['lsv2_pt_'],
  },
  {
    id: 'langchain-langsmith-service-key',
    description: 'LangSmith service API key.',
    pattern: /\b(lsv2_sk_[0-9a-fA-F]{32}_[0-9a-fA-F]{10})/g,
    keywords: ['lsv2_sk_'],
  },
  {
    id: 'lark-app-id',
    description: 'Lark application ID, used as a component of the Lark application-secret rule.',
    pattern: /\b(cli_[A-Za-z0-9]{16})/g,
    keywords: ['cli_'],
  },
  {
    id: 'lark-app-secret',
    description: 'Lark application secret.',
    pattern:
      /(?:lark|larksuite)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['lark'],
  },
  {
    id: 'launchdarkly-access-token',
    description:
      'Uncovered a Launchdarkly Access Token, potentially compromising feature flag management and application functionality.',
    pattern:
      /(?:launchdarkly)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9=_-]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['launchdarkly'],
  },
  {
    id: 'lichess-personal-access-token',
    description: 'Lichess personal access token.',
    pattern: /\b(lip_[A-Za-z0-9_]{16,60})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['lip_'],
  },
  {
    id: 'lighton-paradigm-api-key',
    description:
      'Detected a LightOn Paradigm API key, which may expose enterprise LLM services to unauthorized access.',
    pattern:
      /(?:lighton|paradigm)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9_-]{40,80})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['lighton', 'paradigm'],
  },
  {
    id: 'linear-api-key',
    description: 'Detected a Linear API Token, posing a risk to project management tools and sensitive task data.',
    pattern: /lin_api_[a-z0-9]{40}/gi,
    keywords: ['lin_api_'],
  },
  {
    id: 'linear-client-secret',
    description:
      'Identified a Linear Client Secret, which may compromise secure integrations and sensitive project management data.',
    pattern:
      /(?:linear)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['linear'],
  },
  {
    id: 'linkedin-client-id',
    description:
      'Found a LinkedIn Client ID, risking unauthorized access to LinkedIn integrations and professional data exposure.',
    pattern:
      /(?:linked[_-]?in)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{14})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['linkedin', 'linked_in', 'linked-in'],
  },
  {
    id: 'linkedin-client-secret',
    description:
      'Discovered a LinkedIn Client secret, potentially compromising LinkedIn application integrations and user data.',
    pattern:
      /(?:linked[_-]?in)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['linkedin', 'linked_in', 'linked-in'],
  },
  {
    id: 'lob-api-key',
    description:
      'Uncovered a Lob API Key, which could lead to unauthorized access to mailing and address verification services.',
    pattern:
      /(?:lob)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}((live|test)_[a-f0-9]{35})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['test_', 'live_'],
  },
  {
    id: 'lob-pub-api-key',
    description: 'Detected a Lob Publishable API Key, posing a risk of exposing mail and print service integrations.',
    pattern:
      /(?:lob)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}((test|live)_pub_[a-f0-9]{31})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['test_pub_', 'live_pub_'],
  },
  {
    id: 'looker-client-id',
    description:
      'Found a Looker Client ID, risking unauthorized access to a Looker account and exposing sensitive data.',
    pattern:
      /(?:looker)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{20})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['looker'],
  },
  {
    id: 'looker-client-secret',
    description:
      'Found a Looker Client Secret, risking unauthorized access to a Looker account and exposing sensitive data.',
    pattern:
      /(?:looker)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{24})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['looker'],
  },
  {
    id: 'mailchimp-api-key',
    description:
      'Identified a Mailchimp API key, potentially compromising email marketing campaigns and subscriber data.',
    pattern:
      /(?:MailchimpSDK.initialize|mailchimp)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{32}-us\d\d)(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['mailchimp'],
  },
  {
    id: 'mailersend-api-token',
    description: 'MailerSend API token.',
    pattern: /\b(mlsn\.[A-Za-z0-9]{30,100})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['mlsn.'],
  },
  {
    id: 'mailgun-private-api-token',
    description: 'Found a Mailgun private API token, risking unauthorized email service operations and data breaches.',
    pattern:
      /(?:mailgun)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(key-[a-f0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['mailgun'],
  },
  {
    id: 'mailgun-pub-key',
    description:
      'Discovered a Mailgun public validation key, which could expose email verification processes and associated data.',
    pattern:
      /(?:mailgun)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(pubkey-[a-f0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['mailgun'],
  },
  {
    id: 'mailgun-signing-key',
    description:
      'Uncovered a Mailgun webhook signing key, potentially compromising email automation and data integrity.',
    pattern:
      /(?:mailgun)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-h0-9]{32}-[a-h0-9]{8}-[a-h0-9]{8})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['mailgun'],
  },
  {
    id: 'mapbox-api-token',
    description:
      'Detected a MapBox API token, posing a risk to geospatial services and sensitive location data exposure.',
    pattern:
      /(?:mapbox)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(pk\.[a-z0-9]{60}\.[a-z0-9]{22})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['mapbox'],
  },
  {
    id: 'mattermost-access-token',
    description:
      'Identified a Mattermost Access Token, which may compromise team communication channels and data privacy.',
    pattern:
      /(?:mattermost)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{26})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['mattermost'],
  },
  {
    id: 'maxmind-license-key',
    description: 'Discovered a potential MaxMind license key.',
    pattern: /\b([A-Za-z0-9]{6}_[A-Za-z0-9]{29}_mmk)(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['_mmk'],
  },
  {
    id: 'mercury-production-api-token',
    description: 'Mercury production API token.',
    pattern: /\b(mercury_production_[a-z]{3,6}_[A-Za-z0-9]{40,50}_yrucrem)(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['mercury_production_'],
  },
  {
    id: 'mergify-application-key',
    description: 'Mergify application API key.',
    pattern: /\b(mergify_application_key_[A-Za-z0-9_-]{40,200})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['mergify_application_key_'],
  },
  {
    id: 'messagebird-api-token',
    description:
      'Found a MessageBird API token, risking unauthorized access to communication platforms and message data.',
    pattern:
      /(?:message[_-]?bird)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{25})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['messagebird', 'message-bird', 'message_bird'],
  },
  {
    id: 'messagebird-client-id',
    description:
      'Discovered a MessageBird client ID, potentially compromising API integrations and sensitive communication data.',
    pattern:
      /(?:message[_-]?bird)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['messagebird', 'message-bird', 'message_bird'],
  },
  {
    id: 'microsoft-teams-webhook',
    description:
      'Uncovered a Microsoft Teams Webhook, which could lead to unauthorized access to team collaboration tools and data leaks.',
    pattern:
      /https:\/\/[a-z0-9]+\.webhook\.office\.com\/webhookb2\/[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}@[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}\/IncomingWebhook\/[a-z0-9]{32}\/[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}/g,
    keywords: ['webhook.office.com', 'webhookb2', 'incomingwebhook'],
  },
  {
    id: 'midtrans-production-server-client-key',
    description: 'Midtrans production server or client key.',
    pattern:
      /(?:midtrans|mid[_-]?)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(Mid-(?:server|client)-[A-Za-z0-9_]{10,20})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['mid-server-', 'mid-client-'],
  },
  {
    id: 'minimax-api-key',
    description:
      'Detected a MiniMax API key, which may expose AI model, speech, image, video, or file services to unauthorized access.',
    pattern: /\b(sk-api-[A-Za-z0-9_-]{119})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['sk-api-', 'minimax'],
  },
  {
    id: 'mistral-api-key',
    description: 'Detected a Mistral AI API Key, which may expose AI language model services to unauthorized access.',
    pattern:
      /(?:mistral)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['mistral'],
  },
  {
    id: 'mongodb-atlas-service-account-id',
    description: 'Found a MongoDB Atlas service account client ID.',
    pattern: /\b(mdb_sa_id_[a-f0-9]{24})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['mdb_sa_id_'],
  },
  {
    id: 'mongodb-atlas-service-account-secret',
    description:
      'Detected a MongoDB Atlas service account client secret, which could allow unauthorized Atlas administration API access when paired with a service account client ID.',
    pattern: /\b(mdb_sa_sk_[A-Za-z0-9_-]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['mdb_sa_sk_'],
  },
  {
    id: 'mongodb-connection-string',
    description:
      'Detected a MongoDB connection string with embedded credentials, potentially exposing direct database access and sensitive application data.',
    pattern:
      /\b(mongodb(?:\+srv)?:\/\/(?<username>[!-9;-~]{3,50}):(?<password>[!-?A-~]{3,88})@(?<host>(?:[a-zA-Z0-9][\w.-]+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d{1,5})?(?:,(?:[a-zA-Z0-9][\w.-]+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d{1,5})?)*)\/?(?:(?<authdb>[\w-]+)?(?<options>\?\w+=[\w@/.$-]+(?:&(?:amp;)?\w+=[\w@/.$-]+)*)?)?)(?:['"\s;\x60]|\\[nr]|\b|$)/g,
    keywords: ['mongodb://', 'mongodb+srv://'],
  },
  {
    id: 'neon-api-key',
    description: 'Neon API key.',
    pattern: /\b(napi_[A-Za-z0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['napi_'],
  },
  {
    id: 'netlify-access-token',
    description: 'Detected a Netlify Access Token, potentially compromising web hosting services and site management.',
    pattern:
      /(?:netlify)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9=_-]{40,46})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['netlify'],
  },
  {
    id: 'new-relic-browser-api-token',
    description:
      'Identified a New Relic ingest browser API token, risking unauthorized access to application performance data and analytics.',
    pattern:
      /(?:new-relic|newrelic|new_relic)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(NRJS-[a-f0-9]{19})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['nrjs-'],
  },
  {
    id: 'new-relic-insert-key',
    description: 'Discovered a New Relic insight insert key, compromising data injection into the platform.',
    pattern:
      /(?:new-relic|newrelic|new_relic)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(NRII-[a-z0-9-]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['nrii-'],
  },
  {
    id: 'new-relic-user-api-id',
    description: 'Found a New Relic user API ID, posing a risk to application monitoring services and data integrity.',
    pattern:
      /(?:new-relic|newrelic|new_relic)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['new-relic', 'newrelic', 'new_relic'],
  },
  {
    id: 'new-relic-user-api-key',
    description:
      'Discovered a New Relic user API Key, which could lead to compromised application insights and performance monitoring.',
    pattern:
      /(?:new-relic|newrelic|new_relic)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(NRAK-[a-z0-9]{27})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['nrak'],
  },
  {
    id: 'notion-api-token',
    description: 'Notion API token',
    pattern: /\b(ntn_[0-9]{11}[A-Za-z0-9]{32}[A-Za-z0-9]{3})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['ntn_'],
  },
  {
    id: 'npm-access-token',
    description:
      'Uncovered an npm access token, potentially compromising package management and code repository access.',
    pattern: /\b(npm_[a-z0-9]{36})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['npm_'],
  },
  {
    id: 'nuget-config-password',
    description:
      'Identified a password within a Nuget config file, potentially compromising package management access.',
    pattern: /<add key="(?:(?:ClearText)?Password)"\s*value="(.{8,})"\s*\/>/gi,
    keywords: ['<add key='],
  },
  {
    id: 'nvidia-api-key',
    description:
      'Detected an NVIDIA NIM API Key, which may expose AI inference and GPU cloud services to unauthorized access.',
    pattern: /\b(nvapi-[A-Z0-9_-]{60,70})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['nvapi-'],
  },
  {
    id: 'nytimes-access-token',
    description:
      'Detected a Nytimes Access Token, risking unauthorized access to New York Times APIs and content services.',
    pattern:
      /(?:nytimes|new-york-times|newyorktimes)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9=_-]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['nytimes', 'new-york-times', 'newyorktimes'],
  },
  {
    id: 'octopus-deploy-api-key',
    description:
      'Discovered a potential Octopus Deploy API key, risking application deployments and operational security.',
    pattern: /\b(API-[A-Z0-9]{26})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['api-'],
  },
  {
    id: 'okta-access-token',
    description:
      'Identified an Okta Access Token, which may compromise identity management services and user authentication data.',
    pattern:
      /(?i:(?:(?-i:[Oo]kta|OKTA))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(00[\w=-]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['okta'],
  },
  {
    id: 'ollama-api-key',
    description:
      'Detected an Ollama API Key, which may expose local and hosted AI model serving to unauthorized access.',
    pattern:
      /(?:ollama)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{32}\.[a-zA-Z0-9_-]{24})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['ollama'],
  },
  {
    id: 'onesignal-rich-authentication-token',
    description: 'OneSignal rich authentication token.',
    pattern: /\b(os_v2_(?:app|org)_[a-z2-7]{103})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['os_v2_app_', 'os_v2_org_'],
  },
  {
    id: 'onfido-live-api-token-ca',
    description: 'Onfido live API token.',
    pattern: /\b(api_live_ca\.[A-Za-z0-9_-]{20,80})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['api_live_ca.'],
  },
  {
    id: 'onfido-live-api-token-eu',
    description: 'Onfido live API token.',
    pattern: /\b(api_live\.[A-Za-z0-9_-]{20,80})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['api_live.'],
  },
  {
    id: 'onfido-live-api-token-us',
    description: 'Onfido live API token.',
    pattern: /\b(api_live_us\.[A-Za-z0-9_-]{20,80})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['api_live_us.'],
  },
  {
    id: 'openai-api-key',
    description: 'Found an OpenAI API Key, posing a risk of unauthorized access to AI services and data manipulation.',
    pattern:
      /\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58}|[A-Za-z0-9_-]{20})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58}|[A-Za-z0-9_-]{20})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['t3blbkfj'],
  },
  {
    id: 'openrouter-api-key',
    description:
      'Detected an OpenRouter API Key, which may expose access to multiple AI models through the OpenRouter gateway.',
    pattern: /\b(sk-or-v1-[0-9a-f]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['sk-or-v1-'],
  },
  {
    id: 'openshift-user-token',
    description: 'Found an OpenShift user token, potentially compromising an OpenShift/Kubernetes cluster.',
    pattern: /\b(sha256~[\w-]{43})(?:[^\w-]|$)/g,
    keywords: ['sha256~'],
  },
  {
    id: 'openweather-api-key',
    description: 'OpenWeather API key.',
    pattern:
      /(?i:(?:openweather|pyowm)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['openweather', 'pyowm'],
  },
  {
    id: 'ovh-application-key',
    description: 'OVHcloud Application Key - component of authenticated OVH API requests.',
    pattern:
      /(?:app(?:lication)?[_.-]{0,1}key)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9-]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['ovh'],
  },
  {
    id: 'ovh-application-secret',
    description:
      'OVHcloud Application Secret - component of authenticated OVH API requests, which could allow unauthorized access to OVHcloud infrastructure when combined with Application and Consumer keys.',
    pattern:
      /(?:app(?:lication)?[_.-]{0,1}secret)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9-]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['ovh'],
  },
  {
    id: 'ovh-consumer-key',
    description: 'OVHcloud Consumer Key - component of authenticated OVH API requests.',
    pattern:
      /(?:consumer[_.-]{0,1}key)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9-]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['ovh'],
  },
  {
    id: 'paddle-live-api-key',
    description: 'Paddle live API key.',
    pattern: /\b(pdl_live_apikey_[a-z0-9]{26}_[A-Za-z0-9]{22}_[A-Za-z0-9]{3})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['pdl_live_apikey_'],
  },
  {
    id: 'perplexity-api-key',
    description:
      'Detected a Perplexity API key, which could lead to unauthorized access to Perplexity AI services and data exposure.',
    pattern: /\b(pplx-[a-zA-Z0-9]{48})(?:[\x60'"\s;]|\\[nr]|$|\b)/g,
    keywords: ['pplx-'],
  },
  {
    id: 'persona-production-api-key',
    description: 'Persona production API key.',
    pattern: /\b(persona_production_[a-z0-9_-]{20,80})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['persona_production_'],
  },
  {
    id: 'pinecone-api-key.1',
    description: 'Pinecone API key version 1 (UUID format).',
    pattern:
      /(?i:(?:pinecone(?:[_. -]*(?:api))?[_. -]*(?:secret|key|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['pinecone'],
  },
  {
    id: 'pinecone-api-key.2',
    description: 'Pinecone API key version 2 (pcsk format).',
    pattern: /\b(pcsk_[A-Za-z0-9]{5,6}_[A-Za-z0-9]{63})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['pcsk_'],
  },
  {
    id: 'pinterest-access-token',
    description: 'Pinterest access token.',
    pattern: /\b(pina_[A-Za-z0-9_-]{20,200})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['pina_'],
  },
  {
    id: 'plaid-api-token',
    description:
      'Discovered a Plaid API Token, potentially compromising financial data aggregation and banking services.',
    pattern:
      /(?:plaid)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(access-(?:sandbox|development|production)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['plaid'],
  },
  {
    id: 'plaid-client-id',
    description:
      'Uncovered a Plaid Client ID, which could lead to unauthorized financial service integrations and data breaches.',
    pattern:
      /(?:plaid)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{24})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['plaid'],
  },
  {
    id: 'plaid-secret-key',
    description:
      'Detected a Plaid Secret key, risking unauthorized access to financial accounts and sensitive transaction data.',
    pattern:
      /(?:plaid)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{30})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['plaid'],
  },
  {
    id: 'planetscale-api-token',
    description: 'Identified a PlanetScale API token, potentially compromising database management and operations.',
    pattern: /\b(pscale_tkn_[\w=.-]{32,64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['pscale_tkn_'],
  },
  {
    id: 'planetscale-id',
    description: 'Found a PlanetScale service token ID.',
    pattern: /(?:pscale|planetscale)(?:.|[\n\r]){0,16}?(?:USER|ID|NAME)(?:.|[\n\r]){0,16}?([a-z0-9]{12})/gi,
    keywords: ['pscale', 'planetscale'],
  },
  {
    id: 'planetscale-oauth-token',
    description:
      'Found a PlanetScale OAuth token, posing a risk to database access control and sensitive data integrity.',
    pattern: /\b(pscale_oauth_[\w=.-]{32,64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['pscale_oauth_'],
  },
  {
    id: 'planetscale-password',
    description:
      'Discovered a PlanetScale password, which could lead to unauthorized database operations and data breaches.',
    pattern: /\b(pscale_pw_[\w=.-]{32,64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['pscale_pw_'],
  },
  {
    id: 'plivo-auth-id',
    description: 'Plivo Auth ID, used as a component of the Plivo Auth Token composite rule.',
    pattern:
      /(?:plivo(?:[_. -]*(?:auth|account))?[_. -]*(?:id|sid))(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(MA[A-Z0-9]{18})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['plivo'],
  },
  {
    id: 'plivo-auth-token',
    description: 'Plivo Auth Token.',
    pattern:
      /(?i:(?:plivo(?:[_. -]*(?:auth))?[_. -]*(?:secret|token|key))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9_-]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['plivo'],
  },
  {
    id: 'polar-oauth-access-token',
    description: 'Polar OAuth access token.',
    pattern: /\b(polar_at_[A-Za-z0-9_-]{20,100})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['polar_at_'],
  },
  {
    id: 'polar-organization-access-token',
    description: 'Polar organization access token.',
    pattern: /\b(polar_oat_[A-Za-z0-9_-]{20,100})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['polar_oat_'],
  },
  {
    id: 'polar-personal-access-token',
    description: 'Polar personal access token.',
    pattern: /\b(polar_pat_[A-Za-z0-9_-]{20,100})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['polar_pat_'],
  },
  {
    id: 'polymarket-address',
    description: 'Found a Polymarket wallet address, used as a component of authenticated Polymarket API requests.',
    pattern:
      /(?i:(?:poly.{0,20}address)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(0x[a-fA-F0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['poly'],
  },
  {
    id: 'polymarket-api-key',
    description: 'Identified a Polymarket API key, potentially compromising access to the Polymarket trading platform.',
    pattern:
      /(?i:(?:poly.{0,20}key)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['poly'],
  },
  {
    id: 'polymarket-api-secret',
    description:
      'Discovered a Polymarket API secret, which could be used to sign authenticated requests to the Polymarket L2 API.',
    pattern:
      /(?i:(?:poly.{0,20}secret)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-zA-Z0-9+/]{40,}={0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['poly'],
  },
  {
    id: 'polymarket-passphrase',
    description: 'Found a Polymarket API passphrase, used as a component of authenticated Polymarket API requests.',
    pattern:
      /(?i:(?:poly.{0,20}passphrase)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-zA-Z0-9_]{8,128})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['poly'],
  },
  {
    id: 'polymarket-private-key',
    description: 'Discovered a Polymarket private key, which could allow unauthorized trading and fund transfers.',
    pattern:
      /(?i:(?:poly.{0,20}private.{0,20}key)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(0x[a-fA-F0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['poly'],
  },
  {
    id: 'posthog-personal-api-key',
    description:
      'Detected a PostHog Personal API Key, which may expose administrative access to PostHog analytics projects.',
    pattern: /\b(phx_[a-zA-Z0-9_-]{41,49})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['phx_'],
  },
  {
    id: 'posthog-project-api-key',
    description:
      'Detected a PostHog Project API Key, a public write-only token used to send events to a PostHog project.',
    pattern: /\b(phc_[a-zA-Z0-9_-]{41,44})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['phc_'],
  },
  {
    id: 'postman-api-token',
    description: 'Uncovered a Postman API token, potentially compromising API testing and development workflows.',
    pattern: /\b(PMAK-[a-f0-9]{24}-[a-f0-9]{34})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['pmak-'],
  },
  {
    id: 'prefect-api-token',
    description:
      'Detected a Prefect API token, risking unauthorized access to workflow management and automation services.',
    pattern: /\b(pnu_[a-zA-Z0-9]{36})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['pnu_'],
  },
  {
    id: 'private-key',
    description: 'Identified a Private Key, which may compromise cryptographic security and sensitive data encryption.',
    pattern: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/gi,
    keywords: ['-----begin'],
  },
  {
    id: 'privateai-api-token',
    description:
      'Identified a PrivateAI Token, posing a risk of unauthorized access to AI services and data manipulation.',
    pattern:
      /(?i:(?:private[_-]?ai)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['privateai', 'private_ai', 'private-ai'],
  },
  {
    id: 'proof-full-access-api-key',
    description: 'Proof production full-access API key.',
    pattern: /\b(prf_(?:cli_)?[A-Za-z0-9_-]{20,80})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['prf_'],
  },
  {
    id: 'pulumi-api-token',
    description:
      'Found a Pulumi API token, posing a risk to infrastructure as code services and cloud resource management.',
    pattern: /\b(pul-[a-f0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['pul-'],
  },
  {
    id: 'pypi-upload-token',
    description:
      'Discovered a PyPI upload token, potentially compromising Python package distribution and repository integrity.',
    pattern: /pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}/g,
    keywords: ['pypi-ageichlwas5vcmc'],
  },
  {
    id: 'rainforest-pay-production-api-key',
    description: 'Rainforest Pay production API key.',
    pattern:
      /(?i:(?:rainforest(?:[_. -]*pay)?(?:[_. -]*(?:api))?[_. -]*(?:secret|key|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(apikey_[a-f0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['rainforest'],
  },
  {
    id: 'ramp-client-id',
    description: 'Ramp client ID, used as a component of the Ramp client-secret composite rule.',
    pattern: /\b(ramp_id_[A-Za-z0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['ramp_id_'],
  },
  {
    id: 'ramp-client-secret',
    description: 'Ramp OAuth client secret.',
    pattern: /\b(ramp_sec_[A-Za-z0-9]{48})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['ramp_sec_'],
  },
  {
    id: 'rapidapi-access-token',
    description:
      'Uncovered a RapidAPI Access Token, which could lead to unauthorized access to various APIs and data services.',
    pattern:
      /(?:rapidapi)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9_-]{50})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['rapidapi'],
  },
  {
    id: 'readme-api-token',
    description: 'Detected a Readme API token, risking unauthorized documentation management and content exposure.',
    pattern: /\b(rdme_[a-z0-9]{70})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['rdme_'],
  },
  {
    id: 'redirect-pizza-api-token.1',
    description: 'redirect.pizza API token.',
    pattern: /\b(rpa_[A-Za-z0-9]{30})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['rpa_'],
  },
  {
    id: 'render-api-key',
    description:
      'Detected a Render API key, which may expose hosted services and account resources to unauthorized access.',
    pattern: /\b(rnd_[A-Za-z0-9]{28})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['rnd_'],
  },
  {
    id: 'replicate-api-token',
    description:
      'Detected a Replicate API Token, which may expose AI model hosting and inference services to unauthorized access.',
    pattern: /\b(r8_[A-Za-z0-9]{37})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['r8_'],
  },
  {
    id: 'rootly-api-key.1',
    description: 'Rootly API key.',
    pattern: /\b(rootly_[a-f0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['rootly_'],
  },
  {
    id: 'rubygems-api-token',
    description:
      'Identified a Rubygem API token, potentially compromising Ruby library distribution and package management.',
    pattern: /\b(rubygems_[a-f0-9]{48})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['rubygems_'],
  },
  {
    id: 'runpod-api-key.1',
    description: 'RunPod API key.',
    pattern: /\b(rpa_[A-Z0-9]{40}[A-Za-z0-9]{6})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['rpa_'],
  },
  {
    id: 'salesforce-access-token.1',
    description: 'Salesforce access token.',
    pattern: /\b(00[A-Za-z0-9]{13}![A-Za-z0-9._-]{80,260})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['salesforce.com'],
  },
  {
    id: 'salesforce-instance-url.1',
    description: 'Salesforce instance host, used as a component of the Salesforce access-token rule.',
    pattern:
      /(?:^|[^a-z0-9.-])(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){0,4}\.my\.salesforce\.com|[a-z]{2,8}[0-9]{1,4}\.salesforce\.com))(?:[^a-z0-9.-]|$)/gi,
    keywords: ['salesforce.com'],
  },
  {
    id: 'samsara-api-token.1',
    description: 'Samsara API token.',
    pattern: /\b(samsara_api_[A-Za-z0-9]{26,32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['samsara_api_'],
  },
  {
    id: 'scaleway-secret-key',
    description: 'Identified a standalone Scaleway Secret Key. This can be used to authenticate API requests.',
    pattern:
      /(?:(?:scaleway|scw).{0,20}?(?:secret|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['scaleway', 'scw'],
  },
  {
    id: 'scalingo-api-token',
    description:
      'Found a Scalingo API token, posing a risk to cloud platform services and application deployment security.',
    pattern: /\b(tk-us-[\w-]{48})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['tk-us-'],
  },
  {
    id: 'scalr-api-access-token.1',
    description: 'Scalr API access token.',
    pattern:
      /(?i:(?:scalr(?:[_. -]*(?:api|access))?[_. -]*(?:secret|key|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.eyJpc3MiOiJ1c2VyIiwianRpIjoiYXQt[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{43})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['scalr'],
  },
  {
    id: 'segment-public-api-token.1',
    description: 'Segment workspace bearer token for the Public API.',
    pattern: /\b(sgp_[A-Za-z0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sgp_'],
  },
  {
    id: 'sendbird-access-id',
    description: 'Discovered a Sendbird Access ID, which could compromise chat and messaging platform integrations.',
    pattern:
      /(?:sendbird)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['sendbird'],
  },
  {
    id: 'sendbird-access-token',
    description:
      'Uncovered a Sendbird Access Token, potentially risking unauthorized access to communication services and user data.',
    pattern:
      /(?:sendbird)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['sendbird'],
  },
  {
    id: 'sendgrid-api-token',
    description:
      'Detected a SendGrid API token, posing a risk of unauthorized email service operations and data exposure.',
    pattern: /\b(SG\.[a-z0-9=_\-.]{66})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['sg.'],
  },
  {
    id: 'sendinblue-api-token',
    description:
      'Identified a Brevo (formerly Sendinblue) API token, which may compromise email marketing services and subscriber data privacy.',
    pattern: /\b(xkeysib-[a-fA-F0-9]{64}-[a-zA-Z0-9]{16})\b/g,
    keywords: ['xkeysib-'],
  },
  {
    id: 'sentry-access-token',
    description:
      'Found a Sentry.io Access Token (old format), risking unauthorized access to error tracking services and sensitive application data.',
    pattern:
      /(?:sentry)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['sentry'],
  },
  {
    id: 'sentry-org-token',
    description:
      'Found a Sentry.io Organization Token, risking unauthorized access to error tracking services and sensitive application data.',
    pattern:
      /\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}(?:[^a-zA-Z0-9+/]|$)/g,
    keywords: ['sntrys_eyjpyxqio'],
  },
  {
    id: 'sentry-user-token',
    description:
      'Found a Sentry.io User Token, risking unauthorized access to error tracking services and sensitive application data.',
    pattern: /\b(sntryu_[a-f0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sntryu_'],
  },
  {
    id: 'settlemint-application-access-token',
    description: 'Found a Settlemint Application Access Token.',
    pattern: /\b(sm_aat_[a-zA-Z0-9]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sm_aat'],
  },
  {
    id: 'settlemint-personal-access-token',
    description: 'Found a Settlemint Personal Access Token.',
    pattern: /\b(sm_pat_[a-zA-Z0-9]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sm_pat'],
  },
  {
    id: 'settlemint-service-access-token',
    description: 'Found a Settlemint Service Access Token.',
    pattern: /\b(sm_sat_[a-zA-Z0-9]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sm_sat'],
  },
  {
    id: 'shippo-api-token',
    description: 'Discovered a Shippo API token, potentially compromising shipping services and customer order data.',
    pattern: /\b(shippo_(?:live|test)_[a-fA-F0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['shippo_'],
  },
  {
    id: 'shopify-access-token',
    description:
      'Uncovered a Shopify access token, which could lead to unauthorized e-commerce platform access and data breaches.',
    pattern: /shpat_[a-fA-F0-9]{32}/g,
    keywords: ['shpat_'],
  },
  {
    id: 'shopify-custom-access-token',
    description:
      'Detected a Shopify custom access token, potentially compromising custom app integrations and e-commerce data security.',
    pattern: /shpca_[a-fA-F0-9]{32}/g,
    keywords: ['shpca_'],
  },
  {
    id: 'shopify-private-app-access-token',
    description:
      'Identified a Shopify private app access token, risking unauthorized access to private app data and store operations.',
    pattern: /shppa_[a-fA-F0-9]{32}/g,
    keywords: ['shppa_'],
  },
  {
    id: 'shopify-shared-secret',
    description:
      'Found a Shopify shared secret, posing a risk to application authentication and e-commerce platform security.',
    pattern: /shpss_[a-fA-F0-9]{32}/g,
    keywords: ['shpss_'],
  },
  {
    id: 'sidekiq-secret',
    description:
      'Discovered a Sidekiq Secret, which could lead to compromised background job processing and application data breaches.',
    pattern:
      /(?:BUNDLE_ENTERPRISE__CONTRIBSYS__COM|BUNDLE_GEMS__CONTRIBSYS__COM)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{8}:[a-f0-9]{8})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['bundle_enterprise__contribsys__com', 'bundle_gems__contribsys__com'],
  },
  {
    id: 'sidekiq-sensitive-url',
    description:
      'Uncovered a Sidekiq Sensitive URL, potentially exposing internal job queues and sensitive operation details.',
    pattern:
      /\bhttps?:\/\/([a-f0-9]{8}:[a-f0-9]{8})@(?:gems.contribsys.com|enterprise.contribsys.com)(?:[\\/|#|?|:]|$)/gi,
    keywords: ['gems.contribsys.com', 'enterprise.contribsys.com'],
  },
  {
    id: 'slack-app-token',
    description:
      'Detected a Slack App-level token, risking unauthorized access to Slack applications and workspace data.',
    pattern: /xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/gi,
    keywords: ['xapp'],
  },
  {
    id: 'slack-bot-token',
    description:
      'Identified a Slack Bot token, which may compromise bot integrations and communication channel security.',
    pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g,
    keywords: ['xoxb'],
  },
  {
    id: 'slack-config-access-token',
    description:
      'Found a Slack Configuration access token, posing a risk to workspace configuration and sensitive data access.',
    pattern: /xoxe.xox[bp]-\d-[A-Z0-9]{163,166}/gi,
    keywords: ['xoxe.xoxb-', 'xoxe.xoxp-'],
  },
  {
    id: 'slack-config-refresh-token',
    description:
      'Discovered a Slack Configuration refresh token, potentially allowing prolonged unauthorized access to configuration settings.',
    pattern: /xoxe-\d-[A-Z0-9]{146}/gi,
    keywords: ['xoxe-'],
  },
  {
    id: 'slack-legacy-bot-token',
    description:
      'Uncovered a Slack Legacy bot token, which could lead to compromised legacy bot operations and data exposure.',
    pattern: /xoxb-[0-9]{8,14}-[a-zA-Z0-9]{18,26}/g,
    keywords: ['xoxb'],
  },
  {
    id: 'slack-legacy-token',
    description:
      'Detected a Slack Legacy token, risking unauthorized access to older Slack integrations and user data.',
    pattern: /xox[os]-\d+-\d+-\d+-[a-fA-F\d]+/g,
    keywords: ['xoxo', 'xoxs'],
  },
  {
    id: 'slack-legacy-workspace-token',
    description:
      'Identified a Slack Legacy Workspace token, potentially compromising access to workspace data and legacy features.',
    pattern: /xox[ar]-(?:\d-)?[0-9a-zA-Z]{8,48}/g,
    keywords: ['xoxa', 'xoxr'],
  },
  {
    id: 'slack-session-cookie',
    description:
      "Detected a Slack session cookie (xoxd-), which authenticates browser and desktop sessions across all of a user's workspaces.",
    pattern: /(xoxd-[\w\\/\\+-]{100,}={0,2})(?:[^\w\\/+=-]|$)/g,
    keywords: ['xoxd-'],
  },
  {
    id: 'slack-session-token',
    description:
      'Detected a Slack client session token (xoxc-), which provides full user-level API access when paired with a session cookie.',
    pattern: /xoxc-\d{9,15}-\d{9,15}-\d{9,15}-[a-f0-9]{64}\b/g,
    keywords: ['xoxc-'],
  },
  {
    id: 'slack-user-token',
    description:
      'Found a Slack User token, posing a risk of unauthorized user impersonation and data access within Slack workspaces.',
    pattern: /xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/g,
    keywords: ['xoxp-', 'xoxe-'],
  },
  {
    id: 'slack-webhook-url',
    description:
      'Discovered a Slack Webhook, which could lead to unauthorized message posting and data leakage in Slack channels.',
    pattern: /(?:https?:\/\/)?hooks.slack.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g,
    keywords: ['hooks.slack.com'],
  },
  {
    id: 'snowflake-account-host.1',
    description: 'Snowflake account host, used as a component of the programmatic access-token rule.',
    pattern: /\b([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.snowflakecomputing\.com)\b/gi,
    keywords: ['snowflakecomputing.com'],
  },
  {
    id: 'snowflake-programmatic-access-token.1',
    description: 'Snowflake programmatic access token.',
    pattern:
      /(?i:(?:(?:snowflake[_. -]*(?:programmatic[_. -]*)?(?:access[_. -]*)?token|sf[_. -]*token))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9_-]{100,500})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['snowflake', 'sf_token'],
  },
  {
    id: 'snyk-api-token',
    description:
      'Uncovered a Snyk API token, potentially compromising software vulnerability scanning and code security.',
    pattern:
      /(?:snyk[_.-]?(?:(?:api|oauth)[_.-]?)?(?:key|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['snyk'],
  },
  {
    id: 'sonar-api-token',
    description:
      'Uncovered a Sonar API token, potentially compromising software vulnerability scanning and code security.',
    pattern:
      /(?:sonar[_.-]?(login|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}((?:squ_|sqp_|sqa_)?[a-z0-9=_-]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['sonar'],
  },
  {
    id: 'sourcegraph-access-token',
    description: 'Sourcegraph is a code search and navigation engine.',
    pattern: /\b(sgp_(?:[a-fA-F0-9]{16}|local)_[a-fA-F0-9]{40}|sgp_[a-fA-F0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['sgp_'],
  },
  {
    id: 'square-access-token',
    description:
      'Detected a Square Access Token, risking unauthorized payment processing and financial transaction exposure.',
    pattern: /\b((?:EAAA|sq0atp-)[\w-]{22,60})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sq0atp-', 'eaaa'],
  },
  {
    id: 'squarespace-access-token',
    description:
      'Identified a Squarespace Access Token, which may compromise website management and content control on Squarespace.',
    pattern:
      /(?:squarespace)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['squarespace'],
  },
  {
    id: 'sslmate-api-key.1',
    description: 'SSLMate API key.',
    pattern:
      /(?i:(?:sslmate(?:[_. -]*(?:api))?[_. -]*(?:secret|key|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9]{36})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sslmate'],
  },
  {
    id: 'stability-ai-api-key',
    description:
      'Detected a Stability AI API Key, which may expose AI image generation services to unauthorized access.',
    pattern:
      /(?:stability)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sk-[A-Za-z0-9]{48})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['stability'],
  },
  {
    id: 'stripe-access-token',
    description:
      'Found a Stripe Access Token, posing a risk to payment processing services and sensitive financial data.',
    pattern: /\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sk_test', 'sk_live', 'sk_prod', 'rk_test', 'rk_live', 'rk_prod'],
  },
  {
    id: 'sumologic-access-id',
    description:
      'Discovered a SumoLogic Access ID, potentially compromising log management services and data analytics integrity.',
    pattern:
      /(?i:(?:(?-i:[Ss]umo|SUMO))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(su[a-zA-Z0-9]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sumo'],
  },
  {
    id: 'sumologic-access-token',
    description:
      'Uncovered a SumoLogic Access Token, which could lead to unauthorized access to log data and analytics insights.',
    pattern:
      /(?:(?-i:[Ss]umo|SUMO))(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['sumo'],
  },
  {
    id: 'supabase-management-token',
    description:
      'Detected a Supabase Management Token, which may allow unauthorized access to Supabase organizations and projects.',
    pattern: /\b(sbp_[a-z0-9_-]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sbp_'],
  },
  {
    id: 'supabase-project-api-key',
    description:
      'Detected a Supabase Project API Key, which may expose project data through Supabase APIs when paired with a project URL.',
    pattern: /\b(sb_secret_[A-Za-z0-9_-]{31})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['sb_secret_'],
  },
  {
    id: 'supabase-project-url',
    description: 'Detected a Supabase project URL, used as a component of the supabase-project-api-key composite rule.',
    pattern: /\b(https:\/\/[a-z0-9]{16,32}\.supabase\.co)\b/g,
    keywords: ['supabase.co'],
  },
  {
    id: 'tableau-personal-access-token-name.1',
    description: 'Tableau personal access-token name, used as a component of the token rule.',
    pattern:
      /(?i:(?:tableau(?:[_. -]*(?:personal[_. -]*access|pat))?[_. -]*(?:token[_. -]*)?name)(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z][A-Za-z0-9_-]{2,50})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['tableau'],
  },
  {
    id: 'tableau-personal-access-token.1',
    description: 'Tableau personal access token.',
    pattern: /\b([A-Za-z0-9+/]{22}==:[A-Za-z0-9]{32})\b/g,
    keywords: ['tableau'],
  },
  {
    id: 'tableau-server-host.1',
    description: 'Tableau Online server host, used as a component of the personal access-token rule.',
    pattern: /\b([a-z0-9-]+\.online\.tableau\.com)\b/gi,
    keywords: ['online.tableau.com'],
  },
  {
    id: 'tailscale-api-key.1',
    description: 'Tailscale API access token.',
    pattern: /\b(tskey-api-[A-Za-z0-9_-]{20,36})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['tskey-api-'],
  },
  {
    id: 'telegram-bot-api-token',
    description:
      'Detected a Telegram Bot API Token, risking unauthorized bot operations and message interception on Telegram.',
    pattern:
      /(?:telegr)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9]{5,16}:(?-i:A)[a-z0-9_-]{34})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['telegr'],
  },
  {
    id: 'telnyx-api-v2-key.1',
    description: 'Telnyx API v2 key.',
    pattern:
      /(?i:(?:telnyx(?:[_. -]*(?:api))?[_. -]*(?:secret|key|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(KEY[0-9A-Za-z_-]{55})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['telnyx'],
  },
  {
    id: 'temporal-cloud-api-key.1',
    description: 'Temporal Cloud API key.',
    pattern:
      /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*Y2NvdW50X2lk[A-Za-z0-9_-]*InRlbXBvcmFsLmlv[A-Za-z0-9_-]*(?:ICJrZXlfaWQiOi|a2V5X2lk|rZXlfaWQi)[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['inrlbxbvcmfslmlv'],
  },
  {
    id: 'thunderstore-api-token.1',
    description: 'Thunderstore API token.',
    pattern: /\b(tss_[A-Za-z0-9_-]{20,80})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['tss_'],
  },
  {
    id: 'togetherai-api-key',
    description:
      'Detected a Together.ai API Key, which may expose access to open-source AI models and inference services.',
    pattern: /\b(tgp_v1_[A-Za-z0-9_-]{43})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['tgp_v1_'],
  },
  {
    id: 'travisci-access-token',
    description:
      'Identified a Travis CI Access Token, potentially compromising continuous integration services and codebase security.',
    pattern:
      /(?:travis)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{22})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['travis'],
  },
  {
    id: 'twilio-api-key',
    description:
      'Found a Twilio API Key, posing a risk to communication services and sensitive customer interaction data.',
    pattern: /SK[0-9a-fA-F]{32}/g,
    keywords: ['twilio'],
  },
  {
    id: 'twitch-api-token',
    description: 'Discovered a Twitch API token, which could compromise streaming services and account integrations.',
    pattern:
      /(?:twitch)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{30})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['twitch'],
  },
  {
    id: 'twitter-access-secret',
    description:
      'Uncovered a Twitter Access Secret, potentially risking unauthorized Twitter integrations and data breaches.',
    pattern:
      /(?:twitter)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{45})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['twitter'],
  },
  {
    id: 'twitter-access-token',
    description:
      'Detected a Twitter Access Token, posing a risk of unauthorized account operations and social media data exposure.',
    pattern:
      /(?:twitter)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9]{15,25}-[a-zA-Z0-9]{20,40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['twitter'],
  },
  {
    id: 'twitter-api-key',
    description:
      'Identified a Twitter API Key, which may compromise Twitter application integrations and user data security.',
    pattern:
      /(?:twitter)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{25})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['twitter'],
  },
  {
    id: 'twitter-api-secret',
    description:
      'Found a Twitter API Secret, risking the security of Twitter app integrations and sensitive data access.',
    pattern:
      /(?:twitter)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{50})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['twitter'],
  },
  {
    id: 'twitter-bearer-token',
    description:
      'Discovered a Twitter Bearer Token, potentially compromising API access and data retrieval from Twitter.',
    pattern:
      /(?:twitter)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(A{22}[a-zA-Z0-9%]{80,100})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['twitter'],
  },
  {
    id: 'typeform-api-token',
    description:
      'Uncovered a Typeform API token, which could lead to unauthorized survey management and data collection.',
    pattern:
      /(?:typeform)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(tfp_[a-z0-9\-_.=]{59})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['tfp_'],
  },
  {
    id: 'unkey-root-key.1',
    description: 'Unkey administrative root key.',
    pattern: /\b(unkey_[A-Za-z0-9]{20,32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['unkey_'],
  },
  {
    id: 'upcloud-api-token',
    description:
      'Identified an UpCloud API token, which may expose cloud infrastructure resources to unauthorized access.',
    pattern: /\b(ucat_[0-9A-Za-z]{24,32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['ucat_'],
  },
  {
    id: 'upstage-api-key',
    description:
      'Detected an Upstage AI API key, which may expose Solar language models and document AI services to unauthorized access.',
    pattern:
      /(?:upstage)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Za-z0-9]{40,50})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['upstage'],
  },
  {
    id: 'val-town-api-token.1',
    description: 'Val Town API token.',
    pattern: /\b(vtwn_[A-Za-z0-9_-]{20,80})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['vtwn_'],
  },
  {
    id: 'vault-batch-token',
    description:
      'Detected a Vault Batch Token, risking unauthorized access to secret management services and sensitive data.',
    pattern: /\b(hvb\.[\w-]{138,300})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['hvb.'],
  },
  {
    id: 'vault-service-token',
    description:
      'Identified a Vault Service Token, potentially compromising infrastructure security and access to sensitive credentials.',
    pattern: /\b((?:hvs\.[\w-]{90,120}|s\.(?i:[a-z0-9]{24})))(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['hvs.', 'vault'],
  },
  {
    id: 'vercel-ai-gateway-key',
    description:
      'Detected a Vercel AI Gateway API Key (vck_), which may expose AI model routing and gateway access to unauthorized parties.',
    pattern: /\b(vck_[A-Za-z0-9_-]{56})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['vck_'],
  },
  {
    id: 'vercel-api-token',
    description:
      'Detected a Vercel API Token, which may expose deployment and serverless infrastructure to unauthorized access.',
    pattern:
      /(?:vercel)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([A-Z0-9]{24})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['vercel'],
  },
  {
    id: 'vercel-app-access-token',
    description:
      'Detected a Vercel App Access Token (vca_), which may allow Sign in with Vercel apps to access user resources.',
    pattern: /\b(vca_[A-Za-z0-9_-]{56})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['vca_'],
  },
  {
    id: 'vercel-app-refresh-token',
    description:
      'Detected a Vercel App Refresh Token (vcr_), which may allow persistent unauthorized access through token refresh flows.',
    pattern: /\b(vcr_[A-Za-z0-9_-]{56})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['vcr_'],
  },
  {
    id: 'vercel-integration-token',
    description:
      'Detected a Vercel Integration Token (vci_), which may allow third-party service integrations to act on behalf of users.',
    pattern: /\b(vci_[A-Za-z0-9_-]{56})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['vci_'],
  },
  {
    id: 'vercel-personal-access-token',
    description:
      'Detected a Vercel Personal Access Token (vcp_), which may expose full account and deployment management capabilities.',
    pattern: /\b(vcp_[A-Za-z0-9_-]{56})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['vcp_'],
  },
  {
    id: 'wakatime-api-key.1',
    description: 'WakaTime API key version 1 (UUID format).',
    pattern:
      /(?i:(?:waka[_. -]?time(?:[_. -]*(?:api))?[_. -]*(?:secret|key|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['wakatime', 'waka_time', 'waka-time', 'waka time', 'waka.time'],
  },
  {
    id: 'wakatime-api-key.2',
    description: 'WakaTime API key version 2 (waka_ format).',
    pattern: /\b(waka_[a-z0-9]{36,64})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['waka_'],
  },
  {
    id: 'weatherstack-api-key.1',
    description: 'Weatherstack API key.',
    pattern:
      /(?i:(?:weatherstack(?:[_. -]*(?:api))?[_. -]*(?:secret|key|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([0-9a-z]{32})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['weatherstack'],
  },
  {
    id: 'weights-and-biases-api-key',
    description:
      'Detected a Weights & Biases API Key, which may expose ML experiment tracking and model registry access to unauthorized parties.',
    pattern:
      /(?:wandb|weightsandbiases)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['wandb', 'weightsandbiases'],
  },
  {
    id: 'weights-and-biases-api-key-v1',
    description:
      'Detected a Weights & Biases v1 API Key (wandb_v1_), which may expose ML experiment tracking and artifact storage to unauthorized access.',
    pattern: /\b(wandb_v1_[A-Za-z0-9_]{77})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['wandb_v1_'],
  },
  {
    id: 'workato-developer-api-token.1',
    description: 'Workato Developer API token.',
    pattern:
      /\b(wrka(?:[a-z]{2})?-eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{64,})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['wrka'],
  },
  {
    id: 'workos-production-api-key.1',
    description: 'WorkOS production API key.',
    pattern:
      /(?i:(?:workos(?:[_. -]*(?:api))?[_. -]*(?:secret|key|token))(?:[ \t\w.-]{0,20})[\s'"]{0,3})(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sk_live_a2V5Xz[A-Za-z0-9+/]{69}={0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['workos'],
  },
  {
    id: 'xai-api-key',
    description: 'Detected an xAI (Grok) API Key, which may expose Grok AI model access to unauthorized parties.',
    pattern: /\b(xai-[A-Za-z0-9_-]{70,120})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['xai-'],
  },
  {
    id: 'yandex-access-token',
    description: 'Found a Yandex Access Token, posing a risk to Yandex service integrations and user data privacy.',
    pattern:
      /(?:yandex)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(t1\.[A-Z0-9a-z_-]+[=]{0,2}\.[A-Z0-9a-z_-]{86}[=]{0,2})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['yandex'],
  },
  {
    id: 'yandex-api-key',
    description:
      'Discovered a Yandex API Key, which could lead to unauthorized access to Yandex services and data manipulation.',
    pattern:
      /(?:yandex)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(AQVN[A-Za-z0-9_-]{35,38})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['yandex'],
  },
  {
    id: 'yandex-aws-access-token',
    description:
      'Uncovered a Yandex AWS Access Token, potentially compromising cloud resource access and data security on Yandex Cloud.',
    pattern:
      /(?:yandex)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(YC[a-zA-Z0-9_-]{38})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['yandex'],
  },
  {
    id: 'zai-api-key',
    description: 'Detected a Z.ai API key, which may expose GLM model access and usage to unauthorized parties.',
    pattern:
      /(?:zai|z_ai|z\.ai|glm|zlm)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{32}\.[a-z0-9]{16})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['zai', 'z_ai', 'z.ai', 'glm', 'zlm'],
  },
  {
    id: 'zendesk-secret-key',
    description:
      'Detected a Zendesk Secret Key, risking unauthorized access to customer support services and sensitive ticketing data.',
    pattern:
      /(?:zendesk)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{40})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/gi,
    keywords: ['zendesk'],
  },
  {
    id: 'zuplo-consumer-api-key.1',
    description: 'Zuplo consumer API key.',
    pattern: /\b(zpka_[a-z0-9]{32}_[0-9a-f]{8})(?:\\?['"\x60]|[\s;]|\\[nr]|$)/g,
    keywords: ['zpka_'],
  },
]
