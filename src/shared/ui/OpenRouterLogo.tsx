type OpenRouterLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is OpenRouter. */
const OpenRouterLogo = ({ className = 'w-5 h-5' }: OpenRouterLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="OpenRouter"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" className="fill-foreground" />
    <path
      d="M6.5 9.5h5.5M12 9.5l-2.5-2.5M12 9.5l-2.5 2.5M6.5 14.5h5.5M12 14.5l-2.5-2.5M12 14.5l-2.5 2.5M12 9.5h5"
      className="stroke-background"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default OpenRouterLogo;
