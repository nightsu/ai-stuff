# Bind plan and publication approvals to exact versions

The runtime uses two durable Approval Receipts: plan approval binds the exact question, plan version, local source scope, and budget policy; publication approval separately binds the exact draft content hash and target path. Any relevant change invalidates the corresponding receipt, and recovery revalidates the current action against it, preventing a prior confirmation or model-supplied argument from becoming blanket authority.
