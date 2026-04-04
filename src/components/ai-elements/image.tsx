import { cn } from "@/lib/utils";
import type { Experimental_GeneratedImage } from "ai";

export type ImageProps = Experimental_GeneratedImage & {
  className?: string;
  alt?: string;
};

type ImageRenderProps = Omit<ImageProps, 'uint8Array'>;

export const Image = ({
  base64,
  mediaType,
  ...props
}: ImageRenderProps) => (
  <img
    {...props}
    alt={props.alt}
    className={cn(
      "h-auto max-w-full overflow-hidden rounded-md",
      props.className
    )}
    src={`data:${mediaType};base64,${base64}`}
  />
);
