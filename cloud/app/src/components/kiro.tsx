/**
 * Kiro is supported by Updraft Cloud, but a deployment offers it only once its job image ships
 * the Kiro CLI and its CloudAgents setting lists `kiro` (cloud/README.md). Where it is not
 * offered, the console says so instead of leaving Kiro out without a word (#94).
 */
export function KiroNotEnabled({ className = 'text-sm text-muted-foreground' }: { className?: string }) {
  return (
    <p className={className} data-testid="kiro-not-enabled">
      Kiro is not enabled on this Updraft Cloud deployment. To offer it, the deployment must ship the Kiro CLI in its job image and add <code>kiro</code> to its{' '}
      <code>CloudAgents</code> setting.
    </p>
  );
}
