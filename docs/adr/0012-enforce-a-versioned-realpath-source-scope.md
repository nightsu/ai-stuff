# Enforce a versioned realpath Source Scope

Every Research Run receives an approved Source Scope of canonical local roots, exclusions, UTF-8 text limits, and file-size bounds, whose hash is part of plan approval. Search and read implementations accept only structured arguments, resolve every candidate through realpath containment, reject traversal and symlinks escaping the roots, and revalidate results immediately before access; changes to the scope invalidate prior approval rather than silently expanding authority.
