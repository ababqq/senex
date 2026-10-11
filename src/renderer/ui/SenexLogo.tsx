/**
 * The Senex wordmark with theme-aware neutral stops (a palette's `logo` when set). The E, N, E and X are the
 * letterforms of the original wordmark, moved 2 units left to close the gap; the S is drawn for this app.
 * See GENEX-SOURCES.md.
 */
export function SenexLogo({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      role="img"
      aria-label="Senex"
      width="93"
      height="15"
      viewBox="0 0 92.5 15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(-2 0)">
        <path
          d="M87.0116 5.07172L91.676 0H94.4091L88.615 6.2915C87.9591 7.01909 87.9591 7.96068 88.615 8.68826L94.4091 14.9798H91.676L87.0116 9.90805C86.6837 9.54425 86.3192 9.35165 85.9184 9.35165C85.554 9.35165 85.1532 9.54425 84.8252 9.90805L80.1608 14.9798H77.4277L83.2218 8.68826C83.9142 7.96068 83.9142 7.01909 83.2218 6.2915L77.4277 0H80.1608L84.8252 5.07172C85.1532 5.43552 85.554 5.60671 85.9184 5.60671C86.3192 5.60671 86.6837 5.43552 87.0116 5.07172Z"
          fill="url(#paint0_linear_1520_2271)"
        />
        <path
          d="M66.9152 13.652H75.333V15.0002H59.9551V0.0203894H75.333V1.36857H66.8059C64.0729 1.36857 61.6124 1.2552 61.6124 4.10773C61.6124 6.96025 64.0729 6.78268 66.8059 6.78268H73.6568V8.13086H66.9152C64.1093 8.13086 61.6124 8.15941 61.6124 10.9128C61.6124 13.6662 64.1093 13.652 66.9152 13.652Z"
          fill="url(#paint1_linear_1520_2271)"
        />
        <path
          d="M54.2463 10.4207V0.0205078H56.5056V15.0003H54.2463L44.8082 4.42884C44.4438 4.04365 44.1523 3.85105 43.9336 3.85105C43.715 3.85105 43.5692 4.10785 43.5692 4.60004V15.0003H41.2734V0.0205078H43.5692L53.0073 10.5919C53.3353 10.9771 53.6268 11.1697 53.8455 11.1697C54.1005 11.1697 54.2463 10.9129 54.2463 10.4207Z"
          fill="url(#paint2_linear_1520_2271)"
        />
        <path
          d="M30.0656 13.6521H38.4834V15.0003H23.1055V0.0205078H38.4834V1.36869H29.9563C27.2233 1.36869 24.7628 1.13245 24.7628 4.10784C24.7628 7.08324 27.2233 6.7828 29.9563 6.7828H36.8072V8.13098H30.0656C27.2597 8.13098 24.7628 8.16423 24.7628 10.9129C24.7628 13.6616 27.2597 13.6521 30.0656 13.6521Z"
          fill="url(#paint3_linear_1520_2271)"
        />
      </g>
      <path
        d="M17.8 4.2C17.8 1.88 15.74 0 13.2 0L5.4 0C2.58 0 0.3 2.24 0.3 5C0.3 6.74 2.4 8.15 5 8.15L12.6 8.15C14.2 8.15 15.5 9.6 15.5 11.4C15.5 12.67 13.84 13.7 11.8 13.7L5.6 13.7C3.94 13.7 2.6 12.4 2.6 10.8L0.3 10.8C0.3 13.12 2.58 15 5.4 15L13.2 15C15.74 15 17.8 12.76 17.8 10C17.8 8.26 15.65 6.85 13 6.85L5.4 6.85C3.85 6.85 2.6 5.66 2.6 4.2C2.6 2.6 3.94 1.3 5.6 1.3L12 1.3C13.93 1.3 15.5 2.6 15.5 4.2L17.8 4.2Z"
        fill="url(#paint4_linear_1520_2271)"
      />
      <defs>
        <linearGradient
          id="paint0_linear_1520_2271"
          x1="84.6155"
          y1="2.60206"
          x2="85.4503"
          y2="24.3073"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--logo, var(--ink))" />
          <stop offset="0.471154" stopColor="var(--logo-2, var(--ink-2))" />
          <stop offset="1" stopColor="var(--logo, var(--ink))" stopOpacity="var(--logo-fade, 0.84)" />
        </linearGradient>
        <linearGradient
          id="paint1_linear_1520_2271"
          x1="66.4642"
          y1="2.62257"
          x2="67.3858"
          y2="24.3208"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--logo, var(--ink))" />
          <stop offset="0.471154" stopColor="var(--logo-2, var(--ink-2))" />
          <stop offset="1" stopColor="var(--logo, var(--ink))" stopOpacity="var(--logo-fade, 0.84)" />
        </linearGradient>
        <linearGradient
          id="paint2_linear_1520_2271"
          x1="47.7209"
          y1="2.62257"
          x2="48.6512"
          y2="24.3201"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--logo, var(--ink))" />
          <stop offset="0.471154" stopColor="var(--logo-2, var(--ink-2))" />
          <stop offset="1" stopColor="var(--logo, var(--ink))" stopOpacity="var(--logo-fade, 0.84)" />
        </linearGradient>
        <linearGradient
          id="paint3_linear_1520_2271"
          x1="29.6146"
          y1="2.62257"
          x2="30.5361"
          y2="24.3208"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--logo, var(--ink))" />
          <stop offset="0.471154" stopColor="var(--logo-2, var(--ink-2))" />
          <stop offset="1" stopColor="var(--logo, var(--ink))" stopOpacity="var(--logo-fade, 0.84)" />
        </linearGradient>
        <linearGradient
          id="paint4_linear_1520_2271"
          x1="8.14413"
          y1="2.61419"
          x2="8.87972"
          y2="24.3056"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--logo, var(--ink))" />
          <stop offset="0.471154" stopColor="var(--logo-2, var(--ink-2))" />
          <stop offset="1" stopColor="var(--logo, var(--ink))" stopOpacity="var(--logo-fade, 0.84)" />
        </linearGradient>
      </defs>
    </svg>
  );
}
