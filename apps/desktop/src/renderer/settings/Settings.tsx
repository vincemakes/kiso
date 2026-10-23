import type { ReactNode } from "react";

export function Settings({ token }: { readonly token: string }): ReactNode {
	return <div className="settings" data-token={token.length > 0} />;
}
