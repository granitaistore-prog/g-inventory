package com.example.ageestimator

import android.content.Context
import android.graphics.Bitmap
import org.tensorflow.lite.Interpreter
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel

/**
 * Обгортка над TensorFlow Lite моделлю для оцінки віку по обличчю.
 *
 * ВАЖЛИВО: файл моделі "age_model.tflite" НЕ включений у цей проєкт
 * (навчена нейромережа — це окремий бінарний файл вагою кілька МБ,
 * його потрібно додати вручну в app/src/main/assets/).
 * Див. README.md, розділ "Модель для визначення віку".
 *
 * Якщо ваша модель має інший розмір входу/виходу — підправте
 * константи INPUT_SIZE / MEAN / STD нижче відповідно до її специфікації.
 */
class AgeEstimator(context: Context) {

    companion object {
        private const val MODEL_FILE = "age_model.tflite"
        private const val INPUT_SIZE = 64      // ширина/висота вхідного зображення моделі
        private const val CHANNELS = 3         // RGB
        private const val MEAN = 127.5f
        private const val STD = 127.5f
    }

    private var interpreter: Interpreter? = null
    var isModelLoaded = false
        private set

    init {
        try {
            interpreter = Interpreter(loadModelFile(context))
            isModelLoaded = true
        } catch (e: Exception) {
            // Модель не знайдена або несумісна — додаток попередить користувача в UI
            isModelLoaded = false
        }
    }

    private fun loadModelFile(context: Context): MappedByteBuffer {
        val fd = context.assets.openFd(MODEL_FILE)
        val inputStream = FileInputStream(fd.fileDescriptor)
        val channel = inputStream.channel
        return channel.map(FileChannel.MapMode.READ_ONLY, fd.startOffset, fd.declaredLength)
    }

    /** Приймає обрізане зображення обличчя, повертає приблизний вік або null, якщо модель не завантажена. */
    fun estimateAge(faceBitmap: Bitmap): Int? {
        val interp = interpreter ?: return null

        val resized = Bitmap.createScaledBitmap(faceBitmap, INPUT_SIZE, INPUT_SIZE, true)
        val inputBuffer = ByteBuffer.allocateDirect(4 * INPUT_SIZE * INPUT_SIZE * CHANNELS)
        inputBuffer.order(ByteOrder.nativeOrder())

        val pixels = IntArray(INPUT_SIZE * INPUT_SIZE)
        resized.getPixels(pixels, 0, INPUT_SIZE, 0, 0, INPUT_SIZE, INPUT_SIZE)

        for (pixel in pixels) {
            val r = (pixel shr 16 and 0xFF)
            val g = (pixel shr 8 and 0xFF)
            val b = (pixel and 0xFF)
            inputBuffer.putFloat((r - MEAN) / STD)
            inputBuffer.putFloat((g - MEAN) / STD)
            inputBuffer.putFloat((b - MEAN) / STD)
        }

        // Більшість регресійних моделей віку повертають один float у виході [1][1]
        val output = Array(1) { FloatArray(1) }
        interp.run(inputBuffer, output)

        return output[0][0].toInt().coerceIn(0, 100)
    }

    fun close() {
        interpreter?.close()
    }
}
