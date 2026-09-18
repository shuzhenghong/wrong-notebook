"use client";

import { useState, useRef, useEffect } from "react";
import ReactCrop, { Crop, PixelCrop, centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";

interface ImageCropperProps {
    imageSrc: string;
    open: boolean;
    onClose: () => void;
    onCropComplete: (croppedImageBlob: Blob) => void;
    /** 可选：提供后在确认按钮旁显示「提取文字」按钮，走本地 OCR 文字提取流程 */
    onOcrComplete?: (croppedImageBlob: Blob) => void;
}

// Helper to center the crop initially
function centerAspectCrop(
    mediaWidth: number,
    mediaHeight: number,
    aspect: number,
) {
    return centerCrop(
        makeAspectCrop(
            {
                unit: '%',
                width: 90,
            },
            aspect,
            mediaWidth,
            mediaHeight,
        ),
        mediaWidth,
        mediaHeight,
    )
}

export function ImageCropper({ imageSrc, open, onClose, onCropComplete, onOcrComplete }: ImageCropperProps) {
    const { t, language } = useLanguage();
    const [crop, setCrop] = useState<Crop>();
    const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
    const imgRef = useRef<HTMLImageElement>(null);

    function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
        const { width, height } = e.currentTarget;
        // Start with a centered crop covering most of the image
        // Since we want free aspect, we just make a box
        const initialCrop = centerCrop(
            {
                unit: '%',
                width: 80,
                height: 50,
                x: 10,
                y: 25
            },
            width,
            height
        );
        setCrop(initialCrop);
    }

    const getCroppedImg = async (
        image: HTMLImageElement,
        crop: PixelCrop
    ): Promise<Blob | null> => {
        const canvas = document.createElement("canvas");
        const scaleX = image.naturalWidth / image.width;
        const scaleY = image.naturalHeight / image.height;
        canvas.width = crop.width * scaleX;
        canvas.height = crop.height * scaleY;
        const ctx = canvas.getContext("2d");

        if (!ctx) {
            return null;
        }

        ctx.drawImage(
            image,
            crop.x * scaleX,
            crop.y * scaleY,
            crop.width * scaleX,
            crop.height * scaleY,
            0,
            0,
            crop.width * scaleX,
            crop.height * scaleY
        );

        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error("Canvas is empty"));
                    return;
                }
                resolve(blob);
            }, "image/jpeg");
        });
    };

    const getCroppedBlob = async (): Promise<Blob | null> => {
        if (completedCrop && imgRef.current) {
            try {
                return await getCroppedImg(imgRef.current, completedCrop);
            } catch (e) {
                console.error(e);
                return null;
            }
        }
        // 未选择裁剪区域时回退为整张原图
        if (imageSrc) {
            try {
                const res = await fetch(imageSrc);
                return await res.blob();
            } catch (e) {
                console.error(e);
            }
        }
        return null;
    };

    const handleConfirm = async () => {
        const croppedBlob = await getCroppedBlob();
        if (croppedBlob) {
            onCropComplete(croppedBlob);
        }
    };

    const handleOcr = async () => {
        if (!onOcrComplete) return;
        const croppedBlob = await getCroppedBlob();
        if (croppedBlob) {
            onOcrComplete(croppedBlob);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
            <DialogContent className="max-w-3xl h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="p-4 border-b shrink-0">
                    <DialogTitle>{t.common.cropper?.title || "Crop Image"}</DialogTitle>
                </DialogHeader>

                <div className="flex-1 bg-black w-full overflow-auto flex items-center justify-center p-4">
                    <ReactCrop
                        crop={crop}
                        onChange={(_, percentCrop) => setCrop(percentCrop)}
                        onComplete={(c) => setCompletedCrop(c)}
                        className="max-h-full"
                    >
                        <img
                            ref={imgRef}
                            alt="Crop me"
                            src={imageSrc}
                            onLoad={onImageLoad}
                            style={{ maxHeight: '70vh', maxWidth: '100%', objectFit: 'contain' }}
                        />
                    </ReactCrop>
                </div>

                <div className="p-4 border-t bg-background shrink-0">
                    <div className="flex justify-between items-center">
                        <p className="text-sm text-muted-foreground">
                            {t.common.cropper?.hint || "💡 Drag to adjust crop area"}
                        </p>
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={onClose}>
                                {t.common.cancel || "Cancel"}
                            </Button>
                            {onOcrComplete && (
                                <Button variant="outline" onClick={handleOcr}>
                                    {t.common.cropper?.ocrButton || "提取文字"}
                                </Button>
                            )}
                            <Button onClick={handleConfirm}>
                                {t.common.confirm || "Confirm"}
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
