import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: "#10161F",
          border: "1px solid #26313F",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
          <path
            d="M7 1L12 4V10L7 13L2 10V4L7 1Z"
            stroke="#3FE0A0"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="7" cy="7" r="2" fill="#3FE0A0" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
