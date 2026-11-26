.PHONY: dev dev-server dev-app dev-auth-config install lint typecheck test build validate-template \
	smoke deploy-backend deploy-frontend deploy destroy

# CloudFormation stack the infra/ SAM template deploys into. It is threaded through SAM_DEPLOY_ARGS
# (samconfig.toml carries its own stack_name, which would otherwise win). Staging and Production
# are the same stack name in two different accounts; CI picks the account through each GitHub
# environment's AWS_DEPLOYMENT_ROLE_ARN.
STACK_NAME ?= updraft-cloud
# Empty means "whatever samconfig.toml/AWS_REGION says"; CI sets it so a stack never lands in a
# surprise region. The stack must be in us-east-1 for the CloudFront certificate.
DEPLOY_REGION ?=
REGION_ARG = $(if $(DEPLOY_REGION),--region $(DEPLOY_REGION),)
# How long a replaced SPA release's hashed assets stay in the bucket (deploy-frontend).
ASSET_RETENTION_DAYS ?= 7
SAM_DEPLOY_ARGS ?= --stack-name $(STACK_NAME) $(REGION_ARG) \
	--template-file template.yaml \
	--resolve-s3 \
	--no-fail-on-empty-changeset

# Reads one output of $(STACK_NAME). Empty (not an error) when the stack or output does not exist.
define resolve_output_fn
	resolve_output() { \
		aws cloudformation describe-stacks --stack-name $(STACK_NAME) $(REGION_ARG) \
			--query "Stacks[0].Outputs[?OutputKey=='$$1'].OutputValue" \
			--output text 2>/dev/null || true; \
	}
endef

# --------------------------------------------------------------------------- #
# dev: the API (port 8787) and the SPA (Vite, port 5173, proxying /api to 8787) in one terminal.
# Sign-in needs a deployed stack's app client: run `make dev-auth-config` once.
# --------------------------------------------------------------------------- #

dev:
	@trap 'kill 0' EXIT INT TERM; \
	npm run dev --workspace=server & \
	npm run dev --workspace=app & \
	wait

dev-server:
	npm run dev --workspace=server

dev-app:
	npm run dev --workspace=app

# Point a local SPA (and the local API) at a deployed stack's app client: writes
# app/public/auth-config.json (gitignored) from the stack's outputs.
#   make dev-auth-config STACK_NAME=updraft-cloud DEPLOY_REGION=us-east-1
dev-auth-config:
	@set -e; \
	$(resolve_output_fn); \
	POOL=$$(resolve_output UserPoolId); CLIENT=$$(resolve_output UserPoolClientId); \
	if [ -z "$$CLIENT" ] || [ "$$CLIENT" = "None" ]; then \
		echo "dev-auth-config: stack '$(STACK_NAME)' has no UserPoolClientId output" >&2; exit 1; \
	fi; \
	REGION="$(or $(DEPLOY_REGION),$${AWS_REGION:-us-east-1})"; \
	printf '{"region":"%s","userPoolId":"%s","clientId":"%s"}\n' "$$REGION" "$$POOL" "$$CLIENT" > app/public/auth-config.json; \
	echo "dev-auth-config: wrote app/public/auth-config.json for $(STACK_NAME)"

# --------------------------------------------------------------------------- #
# The same scripts CI runs.
# --------------------------------------------------------------------------- #

install:
	npm ci

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm test

build:
	npm run build

# cfn-lint via sam: no AWS credentials needed.
validate-template:
	cd infra && sam validate --lint --region $(or $(DEPLOY_REGION),us-east-1)

# Anonymous post-deploy checks against a deployed URL. No AWS credentials.
#   make smoke URL=https://updraft.readysetcloud.io
smoke:
	@if [ -z "$(URL)" ]; then echo "smoke: URL is required, e.g. make smoke URL=https://..." >&2; exit 1; fi
	node scripts/smoke.mjs --url "$(URL)"

# --------------------------------------------------------------------------- #
# deploy
#
#   deploy-backend   bundle the API (server/dist) -> sam deploy the whole stack
#   deploy-frontend  build the SPA -> write /auth-config.json from the stack's outputs -> upload
#                    the new hashed assets (nothing deleted) -> record the release
#                    (scripts/spa-release.mjs record) -> switch index.html last -> CloudFront
#                    invalidation -> mark the record live -> prune assets of releases replaced
#                    more than ASSET_RETENTION_DAYS ago, so an index.html still in flight or
#                    cached never points at deleted files. Pruning is best-effort: the release is
#                    already live, and a failure only leaves old files behind
#   deploy           both, in that order
#
# There is no `sam build`: the template's ApiFunction points at the bundled server/dist, which
# `sam deploy` zips and uploads itself.
#
# Custom domain (Production passes both):
#   make deploy-backend APP_DOMAIN_NAME=updraft.readysetcloud.io APP_HOSTED_ZONE_ID=Z123...
# Left off, a deploy keeps whatever the stack has (sam deploy reuses the previous value of any
# parameter it is not given). To remove the domain, set both empty.
# --------------------------------------------------------------------------- #

# `Name=Value` for a parameter the caller set, `Name=""` when they set it empty, nothing when they
# did not set it at all. sam parses a bare `Name=` as no override; only `Name=""` is empty.
domain_override = $(if $(filter undefined,$(origin $(2))),,$(if $($(2)),"$(1)=$($(2))",'$(1)=""'))
PARAM_OVERRIDES = $(strip \
	$(call domain_override,AppDomainName,APP_DOMAIN_NAME) \
	$(call domain_override,AppHostedZoneId,APP_HOSTED_ZONE_ID) \
	$(call domain_override,BenchmarkInstallationId,BENCHMARK_INSTALLATION_ID) \
	$(call domain_override,BenchmarkRepositoryId,BENCHMARK_REPOSITORY_ID) \
	$(call domain_override,ManagedClaudeImageName,MANAGED_CLAUDE_IMAGE_NAME) \
	$(call domain_override,ManagedClaudeImageVersion,MANAGED_CLAUDE_IMAGE_VERSION) \
	$(call domain_override,ManagedClaudeConsoleOrigin,MANAGED_CLAUDE_CONSOLE_ORIGIN) \
	$(call domain_override,ClaudeImageDeploymentRoleName,CLAUDE_IMAGE_DEPLOYMENT_ROLE_NAME))

deploy-backend:
	@set -e; \
	STATUS=$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) $(REGION_ARG) \
		--query 'Stacks[0].StackStatus' --output text 2>/dev/null || true); \
	if [ "$$STATUS" = "ROLLBACK_COMPLETE" ]; then \
		echo "deploy-backend: stack '$(STACK_NAME)' is ROLLBACK_COMPLETE (its first create failed) -- deleting it so it can be recreated"; \
		aws cloudformation delete-stack --stack-name $(STACK_NAME) $(REGION_ARG); \
		aws cloudformation wait stack-delete-complete --stack-name $(STACK_NAME) $(REGION_ARG); \
	fi; \
	npm run build --workspace=server; \
	( cd infra && sam deploy $(SAM_DEPLOY_ARGS) $(if $(PARAM_OVERRIDES),--parameter-overrides $(PARAM_OVERRIDES),) ); \
	$(resolve_output_fn); \
	echo; \
	echo "Backend deployed to stack $(STACK_NAME):"; \
	echo "  AppUrl:           $$(resolve_output AppUrl)"; \
	echo "  ApiUrl:           $$(resolve_output ApiUrl)"; \
	echo "  UserPoolClientId: $$(resolve_output UserPoolClientId)"

deploy-frontend:
	@set -e; \
	$(resolve_output_fn); \
	APP_BUCKET=$$(resolve_output AppBucket); \
	DIST_ID=$$(resolve_output AppDistributionId); \
	APP_URL=$$(resolve_output AppUrl); \
	POOL_ID=$$(resolve_output UserPoolId); \
	CLIENT_ID=$$(resolve_output UserPoolClientId); \
	if [ -z "$$APP_BUCKET" ] || [ "$$APP_BUCKET" = "None" ]; then \
		echo "deploy-frontend: stack '$(STACK_NAME)' has no AppBucket output -- run make deploy-backend first" >&2; \
		exit 1; \
	fi; \
	REGION="$(or $(DEPLOY_REGION),$${AWS_REGION:-$${AWS_DEFAULT_REGION:-us-east-1}})"; \
	echo "deploy-frontend: building the SPA"; \
	npm run build --workspace=app; \
	printf '{"region":"%s","userPoolId":"%s","clientId":"%s"}\n' "$$REGION" "$$POOL_ID" "$$CLIENT_ID" > app/dist/auth-config.json; \
	echo "deploy-frontend: publishing to s3://$$APP_BUCKET"; \
	aws s3 sync app/dist/assets "s3://$$APP_BUCKET/assets" $(REGION_ARG) \
		--cache-control 'public, max-age=31536000, immutable'; \
	aws s3 sync app/dist "s3://$$APP_BUCKET" $(REGION_ARG) \
		--exclude 'assets/*' --exclude index.html --exclude auth-config.json \
		--cache-control 'public, max-age=300'; \
	aws s3 cp app/dist/auth-config.json "s3://$$APP_BUCKET/auth-config.json" $(REGION_ARG) \
		--cache-control 'no-cache' --content-type 'application/json'; \
	RELEASE_KEY=$$(node scripts/spa-release.mjs record --bucket "$$APP_BUCKET" --dist app/dist $(REGION_ARG)); \
	aws s3 cp app/dist/index.html "s3://$$APP_BUCKET/index.html" $(REGION_ARG) \
		--cache-control 'no-cache' --content-type 'text/html; charset=utf-8'; \
	echo "deploy-frontend: invalidating $$DIST_ID"; \
	aws cloudfront create-invalidation --distribution-id "$$DIST_ID" --paths '/*' >/dev/null; \
	node scripts/spa-release.mjs activate --bucket "$$APP_BUCKET" --key "$$RELEASE_KEY" $(REGION_ARG) \
		|| echo "deploy-frontend: WARNING could not mark $$RELEASE_KEY live; it is kept as possibly live" >&2; \
	node scripts/spa-release.mjs prune --bucket "$$APP_BUCKET" --dist app/dist \
		--retention-days $(ASSET_RETENTION_DAYS) $(REGION_ARG) \
		|| echo "deploy-frontend: WARNING pruning old assets failed; the release is live and nothing was lost" >&2; \
	echo; \
	echo "Deployed: $$APP_URL"

deploy: deploy-backend deploy-frontend

# Tear the stack down. Guarded behind CONFIRM= because it deletes the API, the SPA bucket and the
# distribution. The table is RETAINED (DeletionPolicy) and survives; delete it by hand if you mean
# to. CloudFormation refuses to delete a non-empty bucket, so the SPA bucket is emptied first.
destroy:
	@set -e; \
	if [ "$(CONFIRM)" != "$(STACK_NAME)" ]; then \
		echo "destroy: this DELETES the stack '$(STACK_NAME)' (API, SPA bucket, distribution)."; \
		echo "         The table is retained."; \
		echo; \
		echo "  make destroy CONFIRM=$(STACK_NAME)"; \
		exit 1; \
	fi; \
	$(resolve_output_fn); \
	BUCKET=$$(resolve_output AppBucket); \
	if [ -n "$$BUCKET" ] && [ "$$BUCKET" != "None" ]; then \
		echo "==> emptying s3://$$BUCKET"; \
		aws s3 rm "s3://$$BUCKET" --recursive $(REGION_ARG) >/dev/null; \
	fi; \
	echo "==> deleting stack $(STACK_NAME)"; \
	aws cloudformation delete-stack --stack-name $(STACK_NAME) $(REGION_ARG); \
	aws cloudformation wait stack-delete-complete --stack-name $(STACK_NAME) $(REGION_ARG); \
	echo "==> $(STACK_NAME) deleted"
