
PUBNUB_KEY_FILE="$HOME/.codestream/pubnub/CodeStream-Testing-QA_Keyset"
MONGO_ACCESS_FILE="$HOME/.codestream/mongo/qa-codestream-dbowner"
#SSL_CERT=
#MIXPANEL_TOKEN_FILE
SLACKBOT_SECRETS_FILE=$HOME/.codestream/slackbot/codestream-qa
SENDGRID_CREDENTIALS_FILE=$HOME/.codestream/sendgrid/qa-api
OTHER_SECRETS_FILE=$HOME/.codestream/codestream-services/qa-api

. $CS_API_TOP/sandbox/defaults.sh

unset CS_API_SETUP_MONGO
export CS_API_PORT=8443
unset CS_API_LOG_CONSOLE_OK
export CS_API_REPLY_TO_DOMAIN=qa.codestream.com
export CS_API_EMAIL_TO=on
export CS_API_OUTBOUND_EMAIL_SQS="qa_outboundEmail"
export CS_API_SLACKBOT_ORIGIN=http://qa-slackbot.codestream.us:11079
